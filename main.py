"""
cannabis-researcher — Unified cannabis data warehouse + analysis service.

Main application entry point. Provides:
  - REST API for strain search/compare
  - Visualization endpoints for network/phylo views
  - ETL ingestion from scraper-service
  - Strain detail endpoints for the frontend
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import or_
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

from src.genomics.data_loader import (
    csv_directory_to_samples,
)
from src.genomics.terpene_analysis import (
    normalize_terpene_profile,
)
from src.genomics.distance_matrix import (
    get_nearest_neighbors,
    create_distance_matrix,
)
from src.genomics.similarity import compute_combined_similarity
from src.viz.server import build_network_data
from src.etl.kannapedia_etl import ingest_kannapedia_record
from src.db import init_db, get_session
from src.models.orm import (
    CanonicalStrainORM,
    GenomicSampleORM,
    ChemicalProfileORM,
    GeneticRelationshipORM,
    SourceGenomicsRecordORM,
    StrainAliasORM,
    ObservationORM,
    ObservationImageORM,
    BreederORM,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

async def save_domain_models_to_db(session, result: dict):
    """Save resolved Kannapedia domain objects to Postgres."""
    # 1. Save / Update CanonicalStrain
    strain_domain = result["strain"]
    stmt = select(CanonicalStrainORM).where(CanonicalStrainORM.primary_name == strain_domain.primary_name)
    strain_orm = (await session.execute(stmt)).scalars().first()
    if not strain_orm:
        strain_orm = CanonicalStrainORM(
            id=strain_domain.id,
            primary_name=strain_domain.primary_name,
            strain_type=strain_domain.strain_type,
            lineage=strain_domain.lineage,
            description=strain_domain.description,
            avg_flowering_days=strain_domain.avg_flowering_days,
            avg_thc_pct=strain_domain.avg_thc_pct,
            avg_cbd_pct=strain_domain.avg_cbd_pct,
            dominant_terpenes=strain_domain.dominant_terpenes,
            aroma_tags=strain_domain.aroma_tags,
            effect_tags=strain_domain.effect_tags,
        )
        session.add(strain_orm)
    else:
        if strain_domain.avg_thc_pct is not None:
            strain_orm.avg_thc_pct = strain_domain.avg_thc_pct
        if strain_domain.avg_cbd_pct is not None:
            strain_orm.avg_cbd_pct = strain_domain.avg_cbd_pct
        if strain_domain.dominant_terpenes:
            strain_orm.dominant_terpenes = strain_domain.dominant_terpenes
            
    await session.flush()
    
    # 2. Save GenomicSample
    sample_domain = result["sample"]
    # Check if sample exists
    stmt_sample = select(GenomicSampleORM).where(GenomicSampleORM.rsp_number == sample_domain.rsp_number)
    existing_sample = (await session.execute(stmt_sample)).scalars().first()
    if existing_sample:
        return
        
    sample_orm = GenomicSampleORM(
        id=sample_domain.id,
        canonical_strain_id=strain_orm.id,
        rsp_number=sample_domain.rsp_number,
        sample_name=sample_domain.sample_name,
        strain_name=sample_domain.strain_name,
        grower=sample_domain.grower,
        accession_date=sample_domain.accession_date,
        reported_sex=sample_domain.reported_sex,
        report_type=sample_domain.report_type,
        rarity=sample_domain.rarity,
        plant_type=sample_domain.plant_type,
        heterozygosity=sample_domain.heterozygosity,
        y_ratio=sample_domain.y_ratio,
        transaction_id=sample_domain.transaction_id,
        shasum_hash=sample_domain.shasum_hash,
        data_files=sample_domain.data_files,
        source=sample_domain.source,
        source_url=sample_domain.source_url,
        is_complete=sample_domain.is_complete,
    )
    session.add(sample_orm)
    await session.flush()
    
    # 3. Save ChemicalProfile
    if sample_domain.chemical_profile:
        cp_domain = sample_domain.chemical_profile
        cp_orm = ChemicalProfileORM(
            id=cp_domain.id,
            sample_id=sample_orm.id,
            thc=cp_domain.thc,
            thca=cp_domain.thca,
            cbd=cp_domain.cbd,
            cbda=cp_domain.cbda,
            thcv=cp_domain.thcv,
            cbc=cp_domain.cbc,
            cbg=cp_domain.cbg,
            cbn=cp_domain.cbn,
            myrcene=cp_domain.myrcene,
            limonene=cp_domain.limonene,
            caryophyllene=cp_domain.caryophyllene,
            pinene_alpha=cp_domain.pinene_alpha,
            pinene_beta=cp_domain.pinene_beta,
            linalool=cp_domain.linalool,
            humulene=cp_domain.humulene,
            terpinolene=cp_domain.terpinolene,
            ocimene=cp_domain.ocimene,
            nerolidol=cp_domain.nerolidol,
            bisabolol=cp_domain.bisabolol,
            borneol=cp_domain.borneol,
            camphene=cp_domain.camphene,
            carene=cp_domain.carene,
            caryophyllene_oxide=cp_domain.caryophyllene_oxide,
            fenchol=cp_domain.fenchol,
            geraniol=cp_domain.geraniol,
            phellandrene=cp_domain.phellandrene,
            terpineol=cp_domain.terpineol,
            terpinene_alpha=cp_domain.terpinene_alpha,
            terpinene_gamma=cp_domain.terpinene_gamma,
            raw_data=cp_domain.raw_data,
        )
        session.add(cp_orm)
        
    # 4. Save GeneticRelationships
    for rel_domain in sample_domain.genetic_relationships:
        rel_orm = GeneticRelationshipORM(
            id=rel_domain.id,
            sample_id_a=sample_orm.id,
            sample_id_b=rel_domain.sample_id_b,
            strain_name_a=rel_domain.strain_name_a,
            strain_name_b=rel_domain.strain_name_b,
            rsp_a=rel_domain.rsp_a,
            rsp_b=rel_domain.rsp_b,
            distance=rel_domain.distance,
            relationship_type=rel_domain.relationship_type,
            source=rel_domain.source,
        )
        session.add(rel_orm)
        
    # 5. Save StrainAlias
    alias_domain = result["alias"]
    alias_orm = StrainAliasORM(
        id=alias_domain.id,
        canonical_strain_id=strain_orm.id,
        name=alias_domain.name,
        source_name=alias_domain.source_name,
        source_id=alias_domain.source_id,
        confidence=alias_domain.confidence,
    )
    session.add(alias_orm)
    
    # 6. Save SourceGenomicsRecord
    src_domain = result["source_record"]
    src_orm = SourceGenomicsRecordORM(
        id=src_domain.id,
        genomic_sample_id=sample_orm.id,
        source_name=src_domain.source_name,
        source_id=src_domain.source_id,
        source_url=src_domain.source_url,
        metadata_fields=src_domain.metadata_fields,
        chemical_fields=src_domain.chemical_fields,
        variant_fields=src_domain.variant_fields,
        payload=src_domain.payload,
    )
    session.add(src_orm)

async def load_state_from_db(session) -> dict:
    """Dynamically reconstruct state from DB to feed viz graph/matrices."""
    stmt_samples = select(GenomicSampleORM).outerjoin(ChemicalProfileORM).options(
        selectinload(GenomicSampleORM.chemical_profile)
    )
    samples_db = (await session.execute(stmt_samples)).scalars().all()
    
    from src.models.genomic_sample import GenomicSample, ChemicalProfile as DomainChemicalProfile, GeneticRelationship as DomainGeneticRelationship
    
    domain_samples = []
    for s_orm in samples_db:
        cp_domain = None
        if s_orm.chemical_profile:
            cp_orm = s_orm.chemical_profile
            cp_domain = DomainChemicalProfile(
                id=cp_orm.id,
                sample_id=cp_orm.sample_id,
                thc=cp_orm.thc,
                thca=cp_orm.thca,
                cbd=cp_orm.cbd,
                cbda=cp_orm.cbda,
                thcv=cp_orm.thcv,
                cbc=cp_orm.cbc,
                cbg=cp_orm.cbg,
                cbn=cp_orm.cbn,
                myrcene=cp_orm.myrcene,
                limonene=cp_orm.limonene,
                caryophyllene=cp_orm.caryophyllene,
                pinene_alpha=cp_orm.pinene_alpha,
                pinene_beta=cp_orm.pinene_beta,
                linalool=cp_orm.linalool,
                humulene=cp_orm.humulene,
                terpinolene=cp_orm.terpinolene,
                ocimene=cp_orm.ocimene,
                nerolidol=cp_orm.nerolidol,
                bisabolol=cp_orm.bisabolol,
                borneol=cp_orm.borneol,
                camphene=cp_orm.camphene,
                carene=cp_orm.carene,
                caryophyllene_oxide=cp_orm.caryophyllene_oxide,
                fenchol=cp_orm.fenchol,
                geraniol=cp_orm.geraniol,
                phellandrene=cp_orm.phellandrene,
                terpineol=cp_orm.terpineol,
                terpinene_alpha=cp_orm.terpinene_alpha,
                terpinene_gamma=cp_orm.terpinene_gamma,
                raw_data=cp_orm.raw_data or {},
            )
            
        stmt_rels = select(GeneticRelationshipORM).where(GeneticRelationshipORM.sample_id_a == s_orm.id)
        rels_db = (await session.execute(stmt_rels)).scalars().all()
        domain_rels = [
            DomainGeneticRelationship(
                id=r.id,
                sample_id_a=r.sample_id_a,
                sample_id_b=r.sample_id_b,
                strain_name_a=r.strain_name_a,
                strain_name_b=r.strain_name_b,
                rsp_a=r.rsp_a,
                rsp_b=r.rsp_b,
                distance=r.distance,
                relationship_type=r.relationship_type,
                source=r.source,
            ) for r in rels_db
        ]
        
        s_domain = GenomicSample(
            id=s_orm.id,
            canonical_strain_id=s_orm.canonical_strain_id,
            rsp_number=s_orm.rsp_number or "",
            sample_name=s_orm.sample_name or "",
            strain_name=s_orm.strain_name or "",
            grower=s_orm.grower,
            accession_date=s_orm.accession_date,
            reported_sex=s_orm.reported_sex,
            report_type=s_orm.report_type,
            rarity=s_orm.rarity,
            plant_type=s_orm.plant_type,
            heterozygosity=s_orm.heterozygosity,
            y_ratio=s_orm.y_ratio,
            transaction_id=s_orm.transaction_id,
            shasum_hash=s_orm.shasum_hash,
            data_files=s_orm.data_files or [],
            source=s_orm.source or "kannapedia",
            source_url=s_orm.source_url,
            is_complete=s_orm.is_complete or False,
            chemical_profile=cp_domain,
            genetic_relationships=domain_rels,
        )
        domain_samples.append(s_domain)
        
    from src.genomics.data_loader import load_strain_data_from_samples
    strains_data, relationships = load_strain_data_from_samples(domain_samples)
    from src.genomics.terpene_analysis import calculate_terpene_relationships
    terpene_relationships = calculate_terpene_relationships(strains_data)
    
    return {
        "strains_data": strains_data,
        "relationships": relationships,
        "terpene_relationships": terpene_relationships,
        "samples": domain_samples,
    }

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load initial data and bootstrap DB from CSV files on startup."""
    await init_db()
    data_dir = os.getenv("KANNAPEDIA_DATA_DIR", "")
    if data_dir and os.path.isdir(data_dir):
        logger.info("Checking database bootstrapping status from %s", data_dir)
        async for session in get_session():
            stmt = select(func.count(CanonicalStrainORM.id))
            count = (await session.execute(stmt)).scalar() or 0
            if count == 0:
                logger.info("Database is empty, bootstrapping from CSV data...")
                samples = csv_directory_to_samples(data_dir)
                existing_strains = {}
                for sample in samples:
                    # Re-use resolve strain
                    from src.etl.kannapedia_etl import _resolve_strain
                    from src.models.strain import StrainAlias
                    from src.models.source_record import SourceGenomicsRecord
                    
                    strain = _resolve_strain(sample.strain_name, existing_strains)
                    sample.canonical_strain_id = strain.id
                    
                    alias = StrainAlias(
                        canonical_strain_id=strain.id,
                        name=sample.strain_name,
                        source_name="kannapedia",
                        source_id=sample.rsp_number,
                    )
                    
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
                    await save_domain_models_to_db(session, result)
                await session.commit()
                logger.info("Successfully bootstrapped %d strains to database.", len(samples))
            else:
                logger.info("Database already contains %d strains. Skipping bootstrap.", count)
    else:
        logger.info("No KANNAPEDIA_DATA_DIR set, database starts as-is.")
    yield
    logger.info("cannabis-researcher stopped")

app = FastAPI(
    title="cannabis-researcher",
    description=(
        "Unified cannabis data warehouse + analysis service. "
        "Provides strain search, genomic analysis, terpene profiling, "
        "and interactive network visualizations."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# Mount static files for viz assets
VIZ_STATIC = os.path.join(os.path.dirname(__file__), "src", "viz", "static")
if os.path.isdir(VIZ_STATIC):
    app.mount("/static", StaticFiles(directory=VIZ_STATIC), name="static")

# ----- Health ----- #

@app.get("/health")
async def health():
    try:
        async for session in get_session():
            strain_count = (await session.execute(select(func.count(CanonicalStrainORM.id)))).scalar() or 0
            obs_count = (await session.execute(select(func.count(ObservationORM.id)))).scalar() or 0
            return {
                "status": "ok",
                "database": "connected",
                "strains_loaded": strain_count,
                "observations_loaded": obs_count,
            }
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

# ----- Frontend SPA ----- #

@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the main SPA frontend."""
    html_path = os.path.join(os.path.dirname(__file__), "src", "viz", "templates", "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()

# ----- Network Data API ----- #

@app.get("/api/network-data")
async def network_data():
    """Full network data payload for the frontend graph."""
    async for session in get_session():
        state = await load_state_from_db(session)
        data = build_network_data(
            state["strains_data"],
            state["relationships"],
            state["terpene_relationships"],
        )
        return data

# ----- Strain List & Search ----- #

@app.get("/api/strains")
async def list_strains(
    complete_only: bool = False,
    search: str = "",
):
    """List all known strains with optional filtering, including live SeedFinder lookup fallback."""
    async for session in get_session():
        stmt = select(CanonicalStrainORM)
        if search:
            # Handle both spaces and underscores in strain names
            search_space = search.replace("_", " ")
            search_underscore = search.replace(" ", "_")
            stmt = stmt.where(
                or_(
                    CanonicalStrainORM.primary_name.ilike(f"%{search}%"),
                    CanonicalStrainORM.primary_name.ilike(f"%{search_space}%"),
                    CanonicalStrainORM.primary_name.ilike(f"%{search_underscore}%"),
                )
            )
        
        strains = (await session.execute(stmt)).scalars().all()
        results = []
        
        for s in strains:
            # Query chemical details for completion and terpene info
            stmt_sample = select(GenomicSampleORM).where(GenomicSampleORM.canonical_strain_id == s.id).options(
                selectinload(GenomicSampleORM.chemical_profile)
            )
            sample = (await session.execute(stmt_sample)).scalars().first()
            
            is_complete = sample.is_complete if sample else False
            
            terpene_summary = {}
            if sample and sample.chemical_profile:
                normalized = normalize_terpene_profile(sample.chemical_profile.terpene_dict)
                sorted_terps = sorted(normalized.items(), key=lambda x: x[1], reverse=True)[:3]
                terpene_summary = {k: round(v, 3) for k, v in sorted_terps}
                
            results.append({
                "name": s.primary_name,
                "rsp": sample.rsp_number if sample else "",
                "complete": is_complete,
                "has_terpenes": bool(terpene_summary),
                "dominant_terpenes": terpene_summary,
            })
            
        # If search query is non-empty and at least 3 characters, also query SeedFinder!
        if search and len(search.strip()) >= 3:
            try:
                from src.collectors.seedfinder_collector import search_seedfinder
                sf_results = await search_seedfinder(search, limit=10)
                local_names = {r["name"].lower().replace("_", " ") for r in results}
                for sf in sf_results:
                    sf_name_normalized = sf["name"].lower().replace("_", " ")
                    if sf_name_normalized not in local_names:
                        results.append({
                            "name": f"{sf['name']} ({sf['breeder']})",
                            "rsp": "",
                            "complete": False,
                            "has_terpenes": False,
                            "dominant_terpenes": {},
                            "source": "seedfinder",
                            "strain_slug": sf["strain_slug"],
                            "breeder_slug": sf["breeder_slug"],
                            "real_name": sf["name"],
                        })
            except Exception as e:
                logger.error(f"SeedFinder live search failed: {e}")
            
            # Forum search fallback: if no local or SeedFinder results found, search the forums!
            if not results:
                try:
                    import asyncio
                    from src.scraper_client import ScraperClient
                    scraper_client = ScraperClient()
                    
                    tasks = [
                        scraper_client.collect({
                            "source": "discourse",
                            "base_url": "https://overgrow.com",
                            "forum_name": "overgrow",
                            "query": search,
                            "limit": 1
                        }),
                        scraper_client.collect({
                            "source": "xenforo",
                            "base_url": "https://www.rollitup.org",
                            "forum_name": "rollitup",
                            "query": search,
                            "limit": 1
                        }),
                        scraper_client.collect({
                            "source": "xenforo",
                            "base_url": "https://www.thcfarmer.com",
                            "forum_name": "thcfarmer",
                            "query": search,
                            "limit": 1
                        })
                    ]
                    forum_results = await asyncio.gather(*tasks, return_exceptions=True)
                    await scraper_client.close()
                    
                    total_posts = 0
                    for fr in forum_results:
                        if isinstance(fr, dict) and "items" in fr:
                            total_posts += len(fr["items"])
                            
                    if total_posts > 0:
                        results.append({
                            "name": f"{search} (Forum Import)",
                            "rsp": "",
                            "complete": False,
                            "has_terpenes": False,
                            "dominant_terpenes": {},
                            "source": "forum",
                            "strain_slug": search.lower().replace(" ", "-"),
                            "breeder_slug": "forum-import",
                            "real_name": search,
                        })
                except Exception as e:
                    logger.error(f"Forum fallback search failed: {e}")
            
        return {"strains": results, "count": len(results)}


async def _save_forum_posts_to_db(session, posts: list[dict], source_name: str, canonical_id: str, reported_strain: str):
    from datetime import datetime
    for p in posts:
        # Check if exists
        stmt = select(ObservationORM).where(ObservationORM.source_id == str(p.get("id")))
        existing = (await session.execute(stmt)).scalars().first()
        if existing:
            continue

        created_at_str = p.get("created_at")
        dt = datetime.fromisoformat(created_at_str).replace(tzinfo=None) if created_at_str else datetime.utcnow()

        title = p.get("title", "")
        body = p.get("body", "")

        obs = ObservationORM(
            source_name=source_name,
            source_id=str(p.get("id")),
            source_url=p.get("url"),
            author=p.get("author"),
            observed_at=dt,
            reported_strain_name=reported_strain,
            canonical_strain_id=canonical_id,
            raw_text=f"Title: {title}\n\n{body}"
        )
        session.add(obs)
        await session.flush()

        # Save associated images
        image_urls = p.get("image_urls", [])
        for url in image_urls:
            img_orm = ObservationImageORM(
                observation_id=obs.id,
                image_url=url
            )
            session.add(img_orm)


@app.post("/api/strains/import")
async def import_strain(request: Request):
    payload = await request.json()
    strain_slug = payload.get("strain_slug")
    breeder_slug = payload.get("breeder_slug")
    if not strain_slug or not breeder_slug:
        return JSONResponse({"error": "Missing strain_slug or breeder_slug"}, status_code=400)

    async for session in get_session():
        # Check if already imported
        alias_source_name = "forum" if breeder_slug == "forum-import" else "seedfinder"
        stmt_alias = select(StrainAliasORM).where(
            (StrainAliasORM.source_name == alias_source_name) & 
            (StrainAliasORM.source_id == f"{strain_slug}:{breeder_slug}")
        )
        alias = (await session.execute(stmt_alias)).scalars().first()
        if alias:
            stmt_cs = select(CanonicalStrainORM).where(CanonicalStrainORM.id == alias.canonical_strain_id)
            strain = (await session.execute(stmt_cs)).scalars().first()
            if strain:
                return await strain_detail(strain.primary_name)

        if breeder_slug == "forum-import":
            primary_name = strain_slug.replace("-", " ").title()
            sf_data = {
                "name": primary_name,
                "breeder": "Unknown Breeder",
                "type": "Unknown",
                "flowering_time_days": None,
                "description": f"Imported from forum discussions for {primary_name}.",
                "lineage": {},
            }
        else:
            # Scrape from SeedFinder
            from src.collectors.seedfinder_collector import scrape_seedfinder_strain
            sf_data = await scrape_seedfinder_strain(strain_slug, breeder_slug)
            if not sf_data or not sf_data.get("name"):
                return JSONResponse({"error": "Strain detail not found on SeedFinder"}, status_code=404)

        # Create breeder if not exists
        breeder_name = sf_data.get("breeder") or breeder_slug.replace("-", " ").title()
        stmt_breeder = select(BreederORM).where(BreederORM.name.ilike(breeder_name))
        breeder = (await session.execute(stmt_breeder)).scalars().first()
        if not breeder:
            breeder = BreederORM(name=breeder_name)
            session.add(breeder)
            await session.flush()

        # Create CanonicalStrain
        primary_name = sf_data["name"]
        
        # Ensure name uniqueness
        stmt_cs_name = select(CanonicalStrainORM).where(CanonicalStrainORM.primary_name.ilike(primary_name))
        strain_orm = (await session.execute(stmt_cs_name)).scalars().first()
        if not strain_orm:
            canonical_name = primary_name.replace(" ", "_")
            stmt_cs_canon = select(CanonicalStrainORM).where(CanonicalStrainORM.primary_name.ilike(canonical_name))
            strain_orm = (await session.execute(stmt_cs_canon)).scalars().first()
            if not strain_orm:
                strain_orm = CanonicalStrainORM(
                    primary_name=canonical_name,
                    breeder_id=breeder.id,
                    strain_type=sf_data.get("type"),
                    avg_flowering_days=sf_data.get("flowering_time_days"),
                    description=sf_data.get("description"),
                    lineage=sf_data.get("lineage") or {},
                )
                session.add(strain_orm)
                await session.flush()

        # Create alias
        alias_orm = StrainAliasORM(
            canonical_strain_id=strain_orm.id,
            name=primary_name,
            source_name=alias_source_name,
            source_id=f"{strain_slug}:{breeder_slug}",
        )
        session.add(alias_orm)
        await session.flush()

        # Scrape forum threads for observations and pictures
        from src.scraper_client import ScraperClient
        scraper_client = ScraperClient()
        try:
            search_query = primary_name
            # Overgrow
            try:
                posts_og = await scraper_client.collect({
                    "source": "discourse",
                    "base_url": "https://overgrow.com",
                    "forum_name": "overgrow",
                    "query": search_query,
                    "limit": 10
                })
                await _save_forum_posts_to_db(session, posts_og.get("items", []), "overgrow", strain_orm.id, search_query)
            except Exception as ex:
                logger.error(f"Failed to scrape Overgrow for {search_query}: {ex}")

            # Rollitup
            try:
                posts_riu = await scraper_client.collect({
                    "source": "xenforo",
                    "base_url": "https://www.rollitup.org",
                    "forum_name": "rollitup",
                    "query": search_query,
                    "limit": 10
                })
                await _save_forum_posts_to_db(session, posts_riu.get("items", []), "rollitup", strain_orm.id, search_query)
            except Exception as ex:
                logger.error(f"Failed to scrape Rollitup for {search_query}: {ex}")

            # THCFarmer
            try:
                posts_thc = await scraper_client.collect({
                    "source": "xenforo",
                    "base_url": "https://www.thcfarmer.com",
                    "forum_name": "thcfarmer",
                    "query": search_query,
                    "limit": 10
                })
                await _save_forum_posts_to_db(session, posts_thc.get("items", []), "thcfarmer", strain_orm.id, search_query)
            except Exception as ex:
                logger.error(f"Failed to scrape THCFarmer for {search_query}: {ex}")
        finally:
            await scraper_client.close()

        # Update observation count on the canonical strain
        stmt_obs_count = select(func.count()).select_from(ObservationORM).where(
            ObservationORM.canonical_strain_id == strain_orm.id
        )
        obs_count = (await session.execute(stmt_obs_count)).scalar() or 0
        strain_orm.observation_count = obs_count

        await session.commit()
        return await strain_detail(strain_orm.primary_name)

# ----- Strain Detail ----- #

@app.get("/api/strains/{strain_name}/detail")
async def strain_detail(strain_name: str):
    """Full detail for a single strain — metadata, chemicals, relationships, and observation notes/quotes."""
    async for session in get_session():
        # Find Canonical Strain or Alias (handle spaces vs underscores)
        name_space = strain_name.replace("_", " ")
        name_underscore = strain_name.replace(" ", "_")
        stmt = select(CanonicalStrainORM).where(
            or_(
                CanonicalStrainORM.primary_name.ilike(strain_name),
                CanonicalStrainORM.primary_name.ilike(name_space),
                CanonicalStrainORM.primary_name.ilike(name_underscore),
            )
        )
        strain = (await session.execute(stmt)).scalars().first()
        
        if not strain:
            # Try aliases
            stmt_alias = select(StrainAliasORM).where(StrainAliasORM.name.ilike(strain_name))
            alias = (await session.execute(stmt_alias)).scalars().first()
            if alias:
                stmt = select(CanonicalStrainORM).where(CanonicalStrainORM.id == alias.canonical_strain_id)
                strain = (await session.execute(stmt)).scalars().first()
                
        if not strain:
            return JSONResponse({"error": f"Strain '{strain_name}' not found"}, status_code=404)
            
        stmt_sample = select(GenomicSampleORM).where(GenomicSampleORM.canonical_strain_id == strain.id).options(
            selectinload(GenomicSampleORM.chemical_profile)
        )
        sample = (await session.execute(stmt_sample)).scalars().first()

        # Eagerly load breeder for strain-level info
        breeder_name = ""
        if strain.breeder_id:
            stmt_br = select(BreederORM).where(BreederORM.id == strain.breeder_id)
            br = (await session.execute(stmt_br)).scalars().first()
            if br:
                breeder_name = br.name
        
        has_observations = bool(strain.observation_count and strain.observation_count > 0)
        
        result = {
            "name": strain.primary_name,
            "rsp": sample.rsp_number if sample else "",
            "complete": (sample.is_complete if sample else False) or has_observations,
            "description": strain.description or "",
            "strain_type": strain.strain_type or "",
            "breeder": breeder_name,
            "lineage": strain.lineage or {},
            "avg_flowering_days": strain.avg_flowering_days,
            "metadata": {},
            "cannabinoids": {},
            "terpenes": {},
        }
        
        if sample:
            result["metadata"] = {
                "grower": sample.grower,
                "accession_date": sample.accession_date,
                "reported_sex": sample.reported_sex,
                "report_type": sample.report_type,
                "rarity": sample.rarity,
                "plant_type": sample.plant_type,
                "heterozygosity": sample.heterozygosity,
            }
            if sample.chemical_profile:
                cp = sample.chemical_profile
                result["cannabinoids"] = {
                    k: v for k, v in {
                        "THC": cp.thc, "THCA": cp.thca,
                        "CBD": cp.cbd, "CBDA": cp.cbda,
                        "THCV": cp.thcv, "CBC": cp.cbc,
                        "CBG": cp.cbg, "CBN": cp.cbn,
                    }.items() if v is not None
                }
                result["total_thc"] = cp.total_thc
                result["total_cbd"] = cp.total_cbd
                result["terpenes"] = cp.terpene_dict
                
            if sample.transaction_id:
                result["blockchain"] = {
                    "txid": sample.transaction_id,
                    "shasum": sample.shasum_hash,
                }
                
        # Reconstruct relationships dynamically
        state = await load_state_from_db(session)
        
        # Genetic neighbors
        genetic_neighbors = []
        for s1, s2, dist in state["relationships"]:
            if s1 == strain.primary_name:
                genetic_neighbors.append({"strain": s2, "distance": dist})
            elif s2 == strain.primary_name:
                genetic_neighbors.append({"strain": s1, "distance": dist})
        genetic_neighbors.sort(key=lambda x: x["distance"])
        result["genetic_neighbors"] = genetic_neighbors[:20]
        
        # Terpene neighbors
        terpene_neighbors = []
        for rel in state["terpene_relationships"]:
            if rel["from"] == strain.primary_name:
                terpene_neighbors.append({"strain": rel["to"], "distance": rel["distance"]})
            elif rel["to"] == strain.primary_name:
                terpene_neighbors.append({"strain": rel["from"], "distance": rel["distance"]})
        terpene_neighbors.sort(key=lambda x: x["distance"])
        result["terpene_neighbors"] = terpene_neighbors[:20]
        
        # Fetch forum observation quotes, source links, and images
        stmt_obs = select(ObservationORM).where(
            (ObservationORM.canonical_strain_id == strain.id) |
            (ObservationORM.reported_strain_name.ilike(strain.primary_name))
        )
        observations = (await session.execute(stmt_obs)).scalars().all()
        
        observations_data = []
        for obs in observations:
            stmt_imgs = select(ObservationImageORM).where(ObservationImageORM.observation_id == obs.id)
            imgs = (await session.execute(stmt_imgs)).scalars().all()
            
            observations_data.append({
                "id": obs.id,
                "source_name": obs.source_name,
                "source_url": obs.source_url,
                "author": obs.author,
                "observed_at": obs.observed_at.isoformat() if obs.observed_at else None,
                "reported_strain_name": obs.reported_strain_name,
                "raw_text": obs.raw_text,
                "images": [
                    {
                        "id": img.id,
                        "image_url": img.image_url,
                        "local_path": img.local_path,
                        "cluster_id": img.cluster_id,
                    } for img in imgs
                ]
            })
        result["observations"] = observations_data
        
        return result

# ----- Neighbors & Similarity ----- #

@app.get("/api/strains/{strain_name}/neighbors")
async def strain_neighbors(strain_name: str, k: int = 10):
    """Find nearest genetic neighbors for a strain."""
    async for session in get_session():
        state = await load_state_from_db(session)
        if not state["relationships"]:
            return {"error": "No data loaded"}
            
        distances, names = create_distance_matrix(state["strains_data"], state["relationships"])
        neighbors = get_nearest_neighbors(distances, names, strain_name, k=k)
        return {"strain": strain_name, "neighbors": neighbors}

@app.get("/api/strains/{strain_name}/similarity")
async def strain_similarity(strain_name: str):
    """Combined genetic + terpene similarity for a strain."""
    async for session in get_session():
        state = await load_state_from_db(session)
        if not state["relationships"]:
            return {"error": "No data loaded"}
            
        all_similarities = compute_combined_similarity(
            state["strains_data"], state["relationships"],
        )
        results = all_similarities.get(strain_name, [])
        return {"strain": strain_name, "similar": results}

# ----- Terpene APIs ----- #

@app.get("/api/strains/{strain_name}/terpene-profile")
async def terpene_profile(strain_name: str):
    """Normalized terpene profile for radar chart display."""
    async for session in get_session():
        stmt = select(CanonicalStrainORM).where(CanonicalStrainORM.primary_name.ilike(strain_name))
        strain = (await session.execute(stmt)).scalars().first()
        if not strain:
            return JSONResponse({"error": "Strain not found"}, status_code=404)
            
        stmt_sample = select(GenomicSampleORM).where(GenomicSampleORM.canonical_strain_id == strain.id).options(
            selectinload(GenomicSampleORM.chemical_profile)
        )
        sample = (await session.execute(stmt_sample)).scalars().first()
        
        if not sample or not sample.chemical_profile:
            return JSONResponse({"error": "No chemical profile found"}, status_code=404)
            
        normalized = normalize_terpene_profile(sample.chemical_profile.terpene_dict)
        total = sum(normalized.values())
        return {
            "strain": strain.primary_name,
            "terpenes": normalized,
            "total": round(total, 3),
            "dominant": max(normalized, key=normalized.get) if normalized else None,
        }

@app.get("/api/terpene-heatmap")
async def terpene_heatmap():
    """Matrix data: strains × terpenes for heatmap visualization."""
    async for session in get_session():
        stmt_samples = select(GenomicSampleORM).outerjoin(ChemicalProfileORM).where(GenomicSampleORM.is_complete == True).options(
            selectinload(GenomicSampleORM.chemical_profile)
        )
        samples = (await session.execute(stmt_samples)).scalars().all()
        
        rows = []
        all_terpenes = set()
        
        for s in samples:
            if not s.chemical_profile:
                continue
            normalized = normalize_terpene_profile(s.chemical_profile.terpene_dict)
            all_terpenes.update(normalized.keys())
            rows.append({"strain": s.strain_name, "values": normalized})
            
        terpene_cols = sorted(all_terpenes)
        return {
            "strains": [r["strain"] for r in rows],
            "terpenes": terpene_cols,
            "matrix": [
                [r["values"].get(t, 0.0) for t in terpene_cols]
                for r in rows
            ],
        }

# ----- ML / Clustering API ----- #

@app.post("/api/ml/cluster")
async def trigger_clustering():
    """Trigger ML image clustering for all unclustered images."""
    from src.ml.clustering import run_image_clustering
    async for session in get_session():
        count = await run_image_clustering(session)
        return {"success": True, "clustered_count": count}

# ----- ETL Ingestion ----- #

@app.post("/api/ingest/kannapedia")
async def ingest_kannapedia(request: Request):
    """Ingest a raw Kannapedia scraper payload into the warehouse."""
    payload = await request.json()
    
    async for session in get_session():
        # Build existing canonical strains dictionary
        stmt = select(CanonicalStrainORM)
        strains_db = (await session.execute(stmt)).scalars().all()
        
        from src.models.strain import CanonicalStrain
        existing_strains = {}
        for s in strains_db:
            # Map ORM to domain models for ETL compatibility
            existing_strains[s.primary_name] = CanonicalStrain(
                id=s.id,
                primary_name=s.primary_name,
                strain_type=s.strain_type,
                lineage=s.lineage or {},
                description=s.description,
            )
            
        result = ingest_kannapedia_record(payload, existing_strains)
        await save_domain_models_to_db(session, result)
        await session.commit()
        
        sample = result["sample"]
        strain = result["strain"]
        
        return {
            "success": True,
            "sample_id": sample.id,
            "strain_id": strain.id,
            "strain_name": sample.strain_name,
            "rsp": sample.rsp_number,
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8005")),
        reload=True,
    )
