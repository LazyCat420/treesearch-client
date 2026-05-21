"""
clustering.py
-------------
Machine learning engine to group similar plant pictures (using CLIP / color histograms)
and correlate cultivars using terpene, effect, and genetic data.
"""
import logging
import hashlib
import re
from typing import Any
import numpy as np
from sqlalchemy import select
from sklearn.cluster import KMeans

logger = logging.getLogger(__name__)

# Check for CLIP / Pillow dependencies
HAS_ML_LIBRARIES = False
try:
    from PIL import Image
    import torch
    from transformers import CLIPProcessor, CLIPModel
    import httpx
    HAS_ML_LIBRARIES = True
except ImportError:
    HAS_ML_LIBRARIES = False

# Global CLIP Model Cache
_clip_model = None
_clip_processor = None

def get_clip_resources():
    """Load CLIP model and processor lazily to avoid startup delays."""
    global _clip_model, _clip_processor
    if not HAS_ML_LIBRARIES:
        return None, None
    if _clip_model is None:
        try:
            logger.info("Initializing lightweight CLIP model...")
            # Use smallest standard CLIP model
            model_name = "openai/clip-vit-base-patch32"
            _clip_processor = CLIPProcessor.from_pretrained(model_name)
            _clip_model = CLIPModel.from_pretrained(model_name)
            logger.info("CLIP model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load CLIP model: {e}")
    return _clip_model, _clip_processor

async def extract_image_embedding(image_url: str) -> list[float]:
    """Download image and extract feature vector (CLIP or color histogram fallback)."""
    if HAS_ML_LIBRARIES:
        try:
            model, processor = get_clip_resources()
            if model and processor:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(image_url)
                    if resp.status_code == 200:
                        from io import BytesIO
                        img = Image.open(BytesIO(resp.content)).convert("RGB")
                        
                        # Generate CLIP features
                        inputs = processor(images=img, return_tensors="pt")
                        with torch.no_grad():
                            image_features = model.get_image_features(**inputs)
                        
                        # Normalize and return
                        feats = image_features[0].cpu().numpy()
                        norm = np.linalg.norm(feats)
                        if norm > 0:
                            feats = feats / norm
                        return feats.tolist()
        except Exception as e:
            logger.warning(f"CLIP feature extraction failed for {image_url}: {e}")
            
        # Fallback to local image processing (color histogram) if download succeeded but CLIP failed
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(image_url)
                if resp.status_code == 200:
                    from io import BytesIO
                    img = Image.open(BytesIO(resp.content)).convert("RGB")
                    img = img.resize((64, 64))
                    hist = img.histogram() # RGB components (768 elements)
                    arr = np.array(hist, dtype=float)
                    norm = np.linalg.norm(arr)
                    if norm > 0:
                        arr = arr / norm
                    return arr.tolist()
        except Exception as e:
            logger.warning(f"Color histogram extraction failed for {image_url}: {e}")

    # Ultimate deterministic hashing fallback if no libraries or download failed
    return get_fallback_features(image_url)

def get_fallback_features(image_url: str) -> list[float]:
    """Deterministic hashing vector mapping image URL to a normalized feature vector."""
    h = hashlib.sha256(image_url.encode()).digest()
    feats = []
    for i in range(16):
        sub_h = hashlib.sha256(h + bytes([i])).digest()
        for b in sub_h:
            feats.append(float(b) / 255.0)
    arr = np.array(feats)
    norm = np.linalg.norm(arr)
    if norm > 0:
        arr = arr / norm
    return arr.tolist()

async def run_image_clustering(session) -> int:
    """Find all unclustered images, generate embeddings, and assign cluster labels."""
    from src.models.orm import ObservationImageORM
    
    # 1. Fetch images without embeddings or cluster_ids
    stmt = select(ObservationImageORM).where(ObservationImageORM.cluster_id == None)
    images = (await session.execute(stmt)).scalars().all()
    if not images:
        return 0
        
    logger.info(f"Extracting features for {len(images)} images...")
    
    # 2. Extract feature vectors
    for img in images:
        if not img.embedding:
            img.embedding = await extract_image_embedding(img.image_url)
            
    # 3. Apply KMeans clustering on all images in database to assign cluster_ids
    stmt_all = select(ObservationImageORM).where(ObservationImageORM.embedding != None)
    all_images = (await session.execute(stmt_all)).scalars().all()
    if len(all_images) < 2:
        for img in all_images:
            img.cluster_id = "cluster_0"
        await session.commit()
        return len(images)
        
    X = np.array([img.embedding for img in all_images])
    n_clusters = max(2, min(len(X) // 2, 15))
    
    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = kmeans.fit_predict(X)
    
    for img, label in zip(all_images, labels):
        img.cluster_id = f"cluster_{label}"
        
    await session.commit()
    logger.info(f"Successfully clustered {len(all_images)} images into {n_clusters} groups.")
    return len(images)

def calculate_cultivar_similarity(
    strain_a: dict,
    strain_b: dict,
    genetic_distance: float | None = 1.0,
) -> float:
    """Calculate combined similarity between two strains (0.0 to 1.0, where 1.0 is identical).
    Combines:
    - Genetics distance (if present)
    - Terpene profile correlation
    - Effects tags Jaccard correlation
    - Plant picture cluster sharing
    """
    scores = []
    weights = []
    
    # 1. Genetics correlation (1 - distance)
    if genetic_distance is not None:
        scores.append(1.0 - genetic_distance)
        weights.append(0.4)
        
    # 2. Terpene correlation (cosine similarity of terpene profiles)
    t_a = strain_a.get("terpenes", {})
    t_b = strain_b.get("terpenes", {})
    if t_a and t_b:
        keys = set(t_a.keys()).union(set(t_b.keys()))
        v_a = [t_a.get(k, 0.0) for k in keys]
        v_b = [t_b.get(k, 0.0) for k in keys]
        norm_a = np.linalg.norm(v_a)
        norm_b = np.linalg.norm(v_b)
        if norm_a > 0 and norm_b > 0:
            cosine = np.dot(v_a, v_b) / (norm_a * norm_b)
            scores.append(float(cosine))
            weights.append(0.3)
            
    # 3. Effects similarity (Jaccard similarity of effects tags)
    e_a = set(strain_a.get("effects", []))
    e_b = set(strain_b.get("effects", []))
    if e_a or e_b:
        intersection = len(e_a.intersection(e_b))
        union = len(e_a.union(e_b))
        jaccard = intersection / union if union > 0 else 0.0
        scores.append(jaccard)
        weights.append(0.15)
        
    # 4. Shared image clusters (Jaccard similarity of image clusters)
    c_a = set(strain_a.get("image_clusters", []))
    c_b = set(strain_b.get("image_clusters", []))
    if c_a or c_b:
        intersection = len(c_a.intersection(c_b))
        union = len(c_a.union(c_b))
        jaccard = intersection / union if union > 0 else 0.0
        scores.append(jaccard)
        weights.append(0.15)
        
    if not scores:
        return 0.0
        
    # Weighted average
    total_weight = sum(weights)
    weighted_score = sum(s * w for s, w in zip(scores, weights)) / total_weight
    return round(weighted_score, 4)
