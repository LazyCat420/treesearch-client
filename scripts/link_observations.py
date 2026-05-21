"""
link_observations.py — Link orphaned forum observations to canonical strains.

Usage:
    cd cannabis-researcher
    venv/bin/python scripts/link_observations.py

Finds observations where canonical_strain_id IS NULL and attempts to
fuzzy-match reported_strain_name against canonical_strains.primary_name
and strain_aliases.name.
"""

import asyncio
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select, func, update
from src.db import init_db, get_session
from src.models.orm import ObservationORM, CanonicalStrainORM, StrainAliasORM

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("link_observations")


def _normalize(name: str) -> str:
    """Normalize a strain name for fuzzy matching."""
    return name.lower().strip().replace("_", " ").replace("-", " ")


async def main():
    await init_db()

    async for session in get_session():
        # Load all canonical strains and aliases into a lookup
        strains = (await session.execute(select(CanonicalStrainORM))).scalars().all()
        aliases = (await session.execute(select(StrainAliasORM))).scalars().all()

        # Build normalized lookup: normalized_name -> canonical_strain_id
        lookup = {}
        for s in strains:
            lookup[_normalize(s.primary_name)] = s.id
        for a in aliases:
            lookup[_normalize(a.name)] = a.canonical_strain_id

        logger.info("Built lookup with %d names (%d strains + %d aliases).",
                     len(lookup), len(strains), len(aliases))

        # Find orphaned observations
        stmt = select(ObservationORM).where(ObservationORM.canonical_strain_id.is_(None))
        orphans = (await session.execute(stmt)).scalars().all()
        logger.info("Found %d orphaned observations.", len(orphans))

        linked = 0
        unlinked = []

        for obs in orphans:
            normalized = _normalize(obs.reported_strain_name or "")
            if normalized in lookup:
                obs.canonical_strain_id = lookup[normalized]
                linked += 1
            else:
                # Try partial matching (e.g., "Jack Herer OG" contains "Jack Herer")
                matched = False
                for name, strain_id in lookup.items():
                    if name in normalized or normalized in name:
                        obs.canonical_strain_id = strain_id
                        linked += 1
                        matched = True
                        break
                if not matched:
                    unlinked.append(obs.reported_strain_name)

        await session.commit()
        logger.info("Linked %d observations. %d remain unlinked.", linked, len(unlinked))

        if unlinked:
            unique_unlinked = sorted(set(unlinked))
            logger.info("Unlinked strain names (%d unique):", len(unique_unlinked))
            for name in unique_unlinked[:20]:
                logger.info("  - %s", name)
            if len(unique_unlinked) > 20:
                logger.info("  ... and %d more", len(unique_unlinked) - 20)

        break

    logger.info("Done!")


if __name__ == "__main__":
    asyncio.run(main())
