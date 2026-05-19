import pytest
import os
from sqlalchemy import select
from src.db import init_db, get_session, engine
from src.models.orm import BreederORM, CanonicalStrainORM
from src.collector import save_strain_data

pytestmark = pytest.mark.asyncio

async def test_database_connection_and_crud():
    # Verify the database URL is pointing to the correct instance
    db_url = str(engine.url)
    assert "10.0.0.16" in db_url or "localhost" in db_url, "Database is not configured to expected host"

    # Initialize tables
    await init_db()

    async for session in get_session():
        # Create a mock breeder
        breeder = BreederORM(
            name="Test Breeder",
            website="https://example.com"
        )
        session.add(breeder)
        await session.flush()  # to get the ID

        # Create a mock strain
        strain = CanonicalStrainORM(
            primary_name="Test Strain 420",
            breeder_id=breeder.id,
            strain_type="hybrid"
        )
        session.add(strain)
        await session.commit()

        # Fetch it back
        stmt = select(CanonicalStrainORM).where(CanonicalStrainORM.primary_name == "Test Strain 420")
        result = await session.execute(stmt)
        fetched_strain = result.scalar_one_or_none()
        
        assert fetched_strain is not None
        assert fetched_strain.primary_name == "Test Strain 420"
        
        # Cleanup test data
        await session.delete(fetched_strain)
        
        breeder_stmt = select(BreederORM).where(BreederORM.id == breeder.id)
        result_breeder = await session.execute(breeder_stmt)
        fetched_breeder = result_breeder.scalar_one_or_none()
        if fetched_breeder:
            await session.delete(fetched_breeder)
            
        await session.commit()
        break

    # Now test the collector logic
    mock_scraped_data = {
        "name": "White Fire",
        "general_info": {
            "Grower": "OG Seed Bank"
        },
        "chemical_content": {
            "cannabinoids": {
                "THC": "24.5%",
                "CBD": "0.1%"
            },
            "terpenoids": {
                "Myrcene": "1.2%",
                "Limonene": "0.8%"
            }
        }
    }
    
    # Save the data
    strain_id = await save_strain_data(mock_scraped_data)
    assert strain_id is not None
    
    # Verify it was saved correctly
    async for session in get_session():
        stmt = select(CanonicalStrainORM).where(CanonicalStrainORM.id == strain_id)
        result = await session.execute(stmt)
        strain = result.scalar_one_or_none()
        
        assert strain is not None
        assert strain.primary_name == "White Fire"
        assert strain.avg_thc_pct == 24.5
        assert strain.avg_cbd_pct == 0.1
        assert "Myrcene" in strain.dominant_terpenes
        
        # Cleanup
        await session.delete(strain)
        
        breeder_stmt = select(BreederORM).where(BreederORM.id == strain.breeder_id)
        result_breeder = await session.execute(breeder_stmt)
        breeder = result_breeder.scalar_one_or_none()
        if breeder:
            await session.delete(breeder)
            
        await session.commit()
        break

