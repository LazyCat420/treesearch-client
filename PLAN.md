# Postgres Integration Plan for Cannabis Researcher

## PHASE 0: Pre-Flight
- Target: `cannabis-researcher` project
- Goal: Connect to Postgres on `10.0.0.16`, run DB migrations/schema setup, and save canonical strains to it.

## PHASE 1: Dependency Setup
- Create a `requirements.txt` in the root of `cannabis-researcher`.
- Include `sqlalchemy`, `asyncpg`, `psycopg2-binary`, `pydantic`, `pytest`, `pytest-asyncio` for DB logic and testing.
- Setup a Python virtual environment to manage dependencies locally.

## PHASE 2: Database Connection Module
- Create `src/db.py`.
- Define an async connection pool using `SQLAlchemy` async engine pointing to `postgresql+asyncpg://postgres:postgres@10.0.0.16:5432/cannabis_researcher` (or configurable via `DATABASE_URL`).
- Create an `init_db` function to create tables if they don't exist.

## PHASE 3: Database Models
- Map the existing dataclasses in `src/models/strain.py` to SQLAlchemy ORM models.
- We need tables for: `breeders`, `strain_aliases`, `canonical_strains`.

## PHASE 4: Scraper Pipeline Hook
- Create `src/pipeline.py` or modify the collection logic to insert scraped Kannapedia data into the Postgres database.
- Parse the data and map it to `CanonicalStrain`, `StrainAlias`.

## PHASE 5: Testing & Verification
- Create `tests/test_db.py`.
- Run pytest to verify that we can connect to `10.0.0.16`, insert a test strain, and fetch it back out.
- Ensure the connection is actually hitting the Synology NAS DB.
