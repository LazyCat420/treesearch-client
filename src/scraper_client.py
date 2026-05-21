"""
scraper_client.py
-----------------
Client to communicate with the scraper-service for data collection.
"""
import os
import httpx
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

class ScraperClient:
    def __init__(self, base_url: Optional[str] = None):
        if not base_url:
            base_url = os.getenv("SCRAPER_SERVICE_URL", "http://localhost:8001")
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=60.0)

    async def scrape(self, url: str, engine: str = "playwright", options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Call the /scrape endpoint of the scraper service."""
        url_endpoint = f"{self.base_url}/scrape"
        payload = {
            "url": url,
            "engine": engine,
            "options": options or {}
        }
        try:
            response = await self.client.post(url_endpoint, json=payload)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Error calling scraper-service scrape: {e}")
            return {"success": False, "error": str(e), "content": None}

    async def collect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Call the /collect endpoint."""
        url = f"{self.base_url}/collect"
        try:
            response = await self.client.post(url, json=payload)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Error calling scraper-service collect: {e}")
            return {"error": str(e), "count": 0, "items": []}

    async def collect_discourse(
        self, 
        base_url: str, 
        forum_name: str, 
        tag: Optional[str] = None, 
        category_slug: Optional[str] = None,
        category_id: Optional[int] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        payload = {
            "source": "discourse",
            "base_url": base_url,
            "forum_name": forum_name,
            "limit": limit
        }
        if tag:
            payload["tag"] = tag
        if category_slug and category_id:
            payload["category_slug"] = category_slug
            payload["category_id"] = category_id

        data = await self.collect(payload)
        return data.get("items", [])

    async def collect_xenforo(
        self,
        base_url: str,
        forum_name: str,
        subforum_path: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        payload = {
            "source": "xenforo",
            "base_url": base_url,
            "forum_name": forum_name,
            "subforum_path": subforum_path,
            "limit": limit
        }
        data = await self.collect(payload)
        return data.get("items", [])

    async def close(self):
        await self.client.aclose()
