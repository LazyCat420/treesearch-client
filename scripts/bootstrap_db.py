"""
bootstrap_db.py — One-time script to populate the cannabis-researcher Postgres
database from the local data/plants/ CSV directory tree.

Usage:
    cd cannabis-researcher
    venv/bin/python scripts/bootstrap_db.py

Reads the 150+ strain folders under data/plants/, converts them to domain
objects via csv_directory_to_samples(), then persists them through
save_domain_models_to_db().

Idempotent: skips strains that already exist in the database.
"""

import asyncio
import logging
import os
import sys

# Ensure project root is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.db import init_db, get_session
from src.genomics.data_loader import csv_directory_to_samples
from src.etl.kannapedia_etl import _resolve_strain
from src.models.strain import StrainAlias
from src.models.source_record import SourceGenomicsRecord
from sqlalchemy import select, func
from src.models.orm import CanonicalStrainORM

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("bootstrap_db")

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "plants")


async def main():
    if not os.path.isdir(DATA_DIR):
        logger.error("Data directory not found: %s", DATA_DIR)
        sys.exit(1)

    logger.info("Initializing database tables...")
    await init_db()

    # Check existing strain count
    async for session in get_session():
        count = (await session.execute(select(func.count(CanonicalStrainORM.id)))).scalar() or 0
        if count > 0:
            logger.info(
                "Database already contains %d canonical strains. "
                "Continuing with incremental insert (duplicates will be skipped).",
                count,
            )
        break

    # Load CSV data into domain objects
    logger.info("Reading CSV directories from %s ...", DATA_DIR)
    samples = csv_directory_to_samples(DATA_DIR)
    logger.info("Parsed %d GenomicSample objects from CSV data.", len(samples))

    if not samples:
        logger.warning("No samples found. Nothing to bootstrap.")
        return

    # Import save function from main (the persistence logic)
    from main import save_domain_models_to_db

    existing_strains = {}
    inserted = 0
    skipped = 0

    async for session in get_session():
        for i, sample in enumerate(samples, 1):
            strain_name = sample.strain_name or sample.rsp_number or "Unknown"

            # Resolve or create canonical strain
            strain = _resolve_strain(strain_name, existing_strains)
            sample.canonical_strain_id = strain.id

            # Build alias
            alias = StrainAlias(
                canonical_strain_id=strain.id,
                name=strain_name,
                source_name="kannapedia",
                source_id=sample.rsp_number,
            )

            # Build source record
            source_record = SourceGenomicsRecord(
                source_id=sample.rsp_number,
                source_url=sample.source_url,
                metadata_fields={},
                chemical_fields={},
                variant_fields=[],
                payload={},
            )
            source_record.genomic_sample_id = sample.id

            result = {
                "sample": sample,
                "source_record": source_record,
                "strain": strain,
                "alias": alias,
            }

            try:
                await save_domain_models_to_db(session, result)
                inserted += 1
            except Exception as e:
                # Duplicate RSP / already exists — skip
                await session.rollback()
                skipped += 1
                if i <= 3 or i % 50 == 0:
                    logger.debug("Skipped %s (%s): %s", strain_name, sample.rsp_number, e)
                continue

            if i % 25 == 0:
                logger.info("  Progress: %d / %d samples processed...", i, len(samples))

        await session.commit()
        logger.info(
            "Bootstrap complete: %d inserted, %d skipped (already existed).",
            inserted, skipped,
        )

    # Final verification
    async for session in get_session():
        for table_name in ["canonical_strains", "genomic_samples", "chemical_profiles", "genetic_relationships"]:
            from sqlalchemy import text
            r = (await session.execute(text(f"SELECT count(*) FROM {table_name}"))).scalar()
            logger.info("  %s: %d rows", table_name, r)
        break

    logger.info("Done!")


if __name__ == "__main__":
    asyncio.run(main())
