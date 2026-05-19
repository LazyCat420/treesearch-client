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

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from src.genomics.data_loader import (
    load_strain_data_from_directory,
    csv_directory_to_samples,
)
from src.genomics.terpene_analysis import (
    calculate_terpene_relationships,
    normalize_terpene_profile,
)
from src.genomics.distance_matrix import (
    get_nearest_neighbors,
    create_distance_matrix,
)
from src.genomics.similarity import compute_combined_similarity
from src.viz.server import build_network_data
from src.etl.kannapedia_etl import ingest_kannapedia_record

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

# In-memory data store (will be replaced by DB in production)
_state: dict = {
    "strains_data": {},
    "relationships": set(),
    "terpene_relationships": [],
    "samples": [],
    "canonical_strains": {},
    "samples_by_name": {},  # strain_name -> GenomicSample
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load initial data on startup."""
    data_dir = os.getenv("KANNAPEDIA_DATA_DIR", "")
    if data_dir and os.path.isdir(data_dir):
        logger.info("Loading data from %s", data_dir)
        _state["strains_data"], _state["relationships"] = load_strain_data_from_directory(data_dir)
        _state["terpene_relationships"] = calculate_terpene_relationships(_state["strains_data"])
        _state["samples"] = csv_directory_to_samples(data_dir)

        # Index samples by strain name for quick lookup
        for s in _state["samples"]:
            _state["samples_by_name"][s.strain_name] = s

        logger.info(
            "Loaded %d strains, %d relationships, %d samples",
            len(_state["strains_data"]),
            len(_state["relationships"]),
            len(_state["samples"]),
        )
    else:
        logger.info("No KANNAPEDIA_DATA_DIR set, starting with empty state")
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
    return {
        "status": "ok",
        "strains_loaded": len(_state["strains_data"]),
        "relationships_loaded": len(_state["relationships"]),
        "samples_loaded": len(_state["samples"]),
    }


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
    data = build_network_data(
        _state["strains_data"],
        _state["relationships"],
        _state["terpene_relationships"],
    )
    return data


# ----- Strain List & Search ----- #

@app.get("/api/strains")
async def list_strains(
    complete_only: bool = False,
    search: str = "",
):
    """List all known strains with optional filtering."""
    results = []
    search_lower = search.lower().strip()

    for name, data in _state["strains_data"].items():
        if complete_only and not data.get("complete", False):
            continue
        if search_lower and search_lower not in name.lower():
            continue

        # Build terpene summary if available
        terpene_summary = {}
        if data.get("terpenes"):
            normalized = normalize_terpene_profile(data["terpenes"])
            # Sort by value descending, take top 3
            sorted_terps = sorted(normalized.items(), key=lambda x: x[1], reverse=True)[:3]
            terpene_summary = {k: round(v, 3) for k, v in sorted_terps}

        results.append({
            "name": name,
            "rsp": data.get("rsp", ""),
            "complete": data.get("complete", False),
            "has_terpenes": bool(data.get("terpenes")),
            "dominant_terpenes": terpene_summary,
        })

    return {"strains": results, "count": len(results)}


# ----- Strain Detail ----- #

@app.get("/api/strains/{strain_name}/detail")
async def strain_detail(strain_name: str):
    """Full detail for a single strain — metadata, chemicals, relationships."""
    data = _state["strains_data"].get(strain_name)
    if not data:
        return JSONResponse({"error": f"Strain '{strain_name}' not found"}, status_code=404)

    # Get the sample object if it exists
    sample = _state["samples_by_name"].get(strain_name)

    # Base info
    result = {
        "name": strain_name,
        "rsp": data.get("rsp", ""),
        "complete": data.get("complete", False),
    }

    # Metadata from sample
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
        # Chemical profile
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
        else:
            result["cannabinoids"] = {}
            result["terpenes"] = {}

        # Blockchain provenance
        if sample.transaction_id:
            result["blockchain"] = {
                "txid": sample.transaction_id,
                "shasum": sample.shasum_hash,
            }
    else:
        result["metadata"] = {}
        result["cannabinoids"] = {}
        result["terpenes"] = data.get("terpenes", {})

    # Genetic relationships for this strain
    genetic_neighbors = []
    for s1, s2, dist in _state["relationships"]:
        if s1 == strain_name:
            genetic_neighbors.append({"strain": s2, "distance": dist})
        elif s2 == strain_name:
            genetic_neighbors.append({"strain": s1, "distance": dist})
    genetic_neighbors.sort(key=lambda x: x["distance"])
    result["genetic_neighbors"] = genetic_neighbors[:20]

    # Terpene relationships
    terpene_neighbors = []
    for rel in _state["terpene_relationships"]:
        if rel["from"] == strain_name:
            terpene_neighbors.append({"strain": rel["to"], "distance": rel["distance"]})
        elif rel["to"] == strain_name:
            terpene_neighbors.append({"strain": rel["from"], "distance": rel["distance"]})
    terpene_neighbors.sort(key=lambda x: x["distance"])
    result["terpene_neighbors"] = terpene_neighbors[:20]

    return result


# ----- Neighbors & Similarity ----- #

@app.get("/api/strains/{strain_name}/neighbors")
async def strain_neighbors(strain_name: str, k: int = 10):
    """Find nearest genetic neighbors for a strain."""
    if not _state["relationships"]:
        return {"error": "No data loaded"}

    distances, names = create_distance_matrix(_state["strains_data"], _state["relationships"])
    neighbors = get_nearest_neighbors(distances, names, strain_name, k=k)
    return {"strain": strain_name, "neighbors": neighbors}


@app.get("/api/strains/{strain_name}/similarity")
async def strain_similarity(strain_name: str):
    """Combined genetic + terpene similarity for a strain."""
    if not _state["relationships"]:
        return {"error": "No data loaded"}

    all_similarities = compute_combined_similarity(
        _state["strains_data"], _state["relationships"],
    )
    results = all_similarities.get(strain_name, [])
    return {"strain": strain_name, "similar": results}


# ----- Terpene APIs (Phase 2 prep) ----- #

@app.get("/api/strains/{strain_name}/terpene-profile")
async def terpene_profile(strain_name: str):
    """Normalized terpene profile for radar chart display."""
    data = _state["strains_data"].get(strain_name)
    if not data or not data.get("terpenes"):
        return JSONResponse({"error": "No terpene data"}, status_code=404)

    normalized = normalize_terpene_profile(data["terpenes"])
    total = sum(normalized.values())

    return {
        "strain": strain_name,
        "terpenes": normalized,
        "total": round(total, 3),
        "dominant": max(normalized, key=normalized.get) if normalized else None,
    }


@app.get("/api/terpene-heatmap")
async def terpene_heatmap():
    """Matrix data: strains × terpenes for heatmap visualization."""
    rows = []
    all_terpenes: set[str] = set()

    for name, data in _state["strains_data"].items():
        if not data.get("terpenes") or not data.get("complete"):
            continue
        normalized = normalize_terpene_profile(data["terpenes"])
        all_terpenes.update(normalized.keys())
        rows.append({"strain": name, "values": normalized})

    terpene_cols = sorted(all_terpenes)
    return {
        "strains": [r["strain"] for r in rows],
        "terpenes": terpene_cols,
        "matrix": [
            [r["values"].get(t, 0.0) for t in terpene_cols]
            for r in rows
        ],
    }


# ----- ETL Ingestion ----- #

@app.post("/api/ingest/kannapedia")
async def ingest_kannapedia(request: Request):
    """Ingest a raw Kannapedia scraper payload into the warehouse."""
    payload = await request.json()
    result = ingest_kannapedia_record(payload, _state["canonical_strains"])

    sample = result["sample"]
    strain = result["strain"]

    # Update in-memory state
    _state["samples"].append(sample)
    _state["samples_by_name"][sample.strain_name] = sample
    _state["strains_data"][sample.strain_name] = {
        "complete": True,
        "rsp": sample.rsp_number,
        "dir_name": "",
    }
    if sample.chemical_profile:
        terpenes = sample.chemical_profile.terpene_dict
        if terpenes:
            _state["strains_data"][sample.strain_name]["terpenes"] = terpenes

    for rel in sample.genetic_relationships:
        _state["relationships"].add((
            rel.strain_name_a, rel.strain_name_b, rel.distance,
        ))

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
        port=int(os.getenv("PORT", "8002")),
        reload=True,
    )
