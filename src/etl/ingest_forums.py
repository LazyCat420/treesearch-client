"""
ingest_forums.py
----------------
ETL script to pull data from Discourse/XenForo via scraper-service
and store it into the ObservationORM in the warehouse.
"""
import asyncio
import logging
import re
from datetime import datetime

from src.scraper_client import ScraperClient
from src.db import get_session, init_db
from src.models.orm import ObservationORM

logger = logging.getLogger(__name__)

# List of cannabis strains to try and match in titles (basic extraction)
KNOWN_STRAINS = ["Blueberry", "White Widow", "Sour Diesel", "OG Kush", "Goji OG", "Northern Lights", "Haze", "Skunk"]

def extract_strain_from_title(title: str) -> str:
    """Basic extraction of a strain name from a post title."""
    for strain in KNOWN_STRAINS:
        if strain.lower() in title.lower():
            return strain
    return ""

async def ingest_discourse(client: ScraperClient, base_url: str, forum_name: str, tags: list[str]):
    """Ingest Discourse topics by tags."""
    for tag in tags:
        logger.info(f"Collecting {forum_name} tag: {tag}")
        posts = await client.collect_discourse(
            base_url=base_url,
            forum_name=forum_name,
            tag=tag,
            limit=50
        )
        await _save_posts(posts, forum_name)

async def ingest_xenforo(client: ScraperClient, base_url: str, forum_name: str, subforums: list[str]):
    """Ingest XenForo topics by subforum paths."""
    for subforum in subforums:
        logger.info(f"Collecting {forum_name} subforum: {subforum}")
        posts = await client.collect_xenforo(
            base_url=base_url,
            forum_name=forum_name,
            subforum_path=subforum,
            limit=50
        )
        await _save_posts(posts, forum_name)

async def _save_posts(posts: list[dict], source_name: str):
    if not posts:
        return
        
    async for session in get_session():
        saved = 0
        for p in posts:
            # Check if exists
            from sqlalchemy import select
            stmt = select(ObservationORM).where(ObservationORM.source_id == str(p.get("id")))
            existing = (await session.execute(stmt)).scalars().first()
            if existing:
                continue

            created_at_str = p.get("created_at")
            dt = datetime.fromisoformat(created_at_str).replace(tzinfo=None) if created_at_str else datetime.utcnow()
            
            strain_name = extract_strain_from_title(p.get("title", ""))

            obs = ObservationORM(
                source_name=source_name,
                source_id=str(p.get("id")),
                source_url=p.get("url"),
                author=p.get("author"),
                observed_at=dt,
                reported_strain_name=strain_name,
                raw_text=f"Title: {p.get('title')}\n\n{p.get('body')}"
            )
            session.add(obs)
            saved += 1
            
        if saved > 0:
            await session.commit()
            logger.info(f"Saved {saved} new observations from {source_name}")


async def run_forum_ingestion():
    await init_db()
    client = ScraperClient()
    try:
        # 1. Overgrow (Discourse)
        await ingest_discourse(
            client, 
            base_url="https://overgrow.com", 
            forum_name="overgrow", 
            tags=["breeding", "growroom-diaries", "indoor", "outdoor", "hydro"]
        )

        # 2. Rollitup (XenForo)
        await ingest_xenforo(
            client,
            base_url="https://www.rollitup.org",
            forum_name="rollitup",
            subforums=["f/grow-journals.54/", "f/breeders-paradise.94/"]
        )
        
        # 3. THCFarmer (XenForo)
        await ingest_xenforo(
            client,
            base_url="https://www.thcfarmer.com",
            forum_name="thcfarmer",
            subforums=["forums/grow-diaries.28/", "forums/cannabis-breeding.50/"]
        )
    finally:
        await client.close()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_forum_ingestion())
