import json
from dataclasses import dataclass, asdict
from typing import Dict, Any

@dataclass
class CanonicalStrain:
    name: str
    genetics: str
    thc_range: tuple
    cbd_range: tuple
    dominant_terpenes: list
    visual_traits: list
    nlp_keywords: list

# Baseline for Super Silver Haze
SSH_BASELINE = CanonicalStrain(
    name="Super Silver Haze",
    genetics="Skunk #1 x Northern Lights #5 x Haze",
    thc_range=(18.0, 23.0),
    cbd_range=(0.0, 1.0),
    dominant_terpenes=["Terpinolene", "Myrcene", "Caryophyllene"],
    visual_traits=["red_leaves", "elongated_colas", "silver_trichomes", "tall_structure"],
    nlp_keywords=["citrus", "earthy", "energetic", "cerebral", "creative"]
)

class PhenotypeMatcher:
    """
    Simulates Machine Learning matching algorithms to verify cannabis cultivars,
    returning detailed audit trails of exactly what data points matched or failed.
    """
    
    @staticmethod
    def match_visual_traits(sample_traits: list, canonical_traits: list) -> Dict[str, Any]:
        if not canonical_traits or not sample_traits:
            return {"score": 0.0, "details": {"matched": [], "missing_from_baseline": canonical_traits, "unexpected_in_sample": sample_traits}}
            
        matched = [t for t in sample_traits if t in canonical_traits]
        missing = [t for t in canonical_traits if t not in sample_traits]
        unexpected = [t for t in sample_traits if t not in canonical_traits]
        
        score = (len(matched) / len(canonical_traits)) * 100
        return {
            "score": score,
            "details": {
                "matched_traits": matched,
                "missing_baseline_traits": missing,
                "unexpected_sample_traits": unexpected
            }
        }

    @staticmethod
    def match_chemical_profile(sample_thc: float, sample_terps: list, canonical: CanonicalStrain) -> Dict[str, Any]:
        score = 0.0
        details = {}
        
        # Check THC bounds
        if canonical.thc_range[0] <= sample_thc <= canonical.thc_range[1]:
            score += 50.0
            details["thc_match"] = f"{sample_thc}% is within baseline {canonical.thc_range}"
        elif abs(sample_thc - canonical.thc_range[0]) <= 2 or abs(sample_thc - canonical.thc_range[1]) <= 2:
            score += 25.0
            details["thc_match"] = f"{sample_thc}% is slightly outside baseline {canonical.thc_range}"
        else:
            details["thc_match"] = f"{sample_thc}% completely missed baseline {canonical.thc_range}"
            
        # Check Terpenes
        matched_terps = [t for t in sample_terps if t in canonical.dominant_terpenes]
        missing_terps = [t for t in canonical.dominant_terpenes if t not in sample_terps]
        
        if len(canonical.dominant_terpenes) > 0:
            score += (len(matched_terps) / len(canonical.dominant_terpenes)) * 50.0
            
        details["terpenes_matched"] = matched_terps
        details["terpenes_missing"] = missing_terps
            
        return {"score": score, "details": details}

    @staticmethod
    def match_nlp_descriptions(sample_text: str, canonical_keywords: list) -> Dict[str, Any]:
        words = sample_text.lower().split()
        matched_keywords = [kw for kw in canonical_keywords if kw in words]
        missing_keywords = [kw for kw in canonical_keywords if kw not in words]
        
        score = min((len(matched_keywords) / len(canonical_keywords)) * 100 + 20, 100.0) # Bonus for context
        return {
            "score": score,
            "details": {
                "extracted_sample_text": sample_text,
                "matched_keywords": matched_keywords,
                "missing_keywords": missing_keywords
            }
        }

    @classmethod
    def generate_report(cls, sample: Dict[str, Any], canonical: CanonicalStrain) -> Dict[str, Any]:
        visual_eval = cls.match_visual_traits(sample.get("extracted_visuals", []), canonical.visual_traits)
        chem_eval = cls.match_chemical_profile(sample.get("thc", 0), sample.get("terpenes", []), canonical)
        nlp_eval = cls.match_nlp_descriptions(sample.get("description", ""), canonical.nlp_keywords)
        
        # Assume Genetics is checked via database provenance
        genetics_match = sample.get("lineage") == canonical.genetics
        genetics_score = 100.0 if genetics_match else 0.0
        genetics_eval = {
            "score": genetics_score,
            "details": {
                "sample_lineage": sample.get("lineage"),
                "baseline_lineage": canonical.genetics,
                "is_exact_match": genetics_match
            }
        }

        # Weighted Ensemble Average
        total_score = (visual_eval["score"] * 0.3) + (chem_eval["score"] * 0.4) + (nlp_eval["score"] * 0.2) + (genetics_score * 0.1)

        report = {
            "OVERALL_CONFIDENCE": f"{total_score:.1f}%",
            "VERDICT": "AUTHENTICATED" if total_score > 85.0 else "INCONCLUSIVE",
            "EVIDENCE": {
                "Visual Match (CLIP/CNN)": {
                    "confidence": f"{visual_eval['score']:.1f}%",
                    "data_points": visual_eval["details"]
                },
                "Chemical Match (Regression)": {
                    "confidence": f"{chem_eval['score']:.1f}%",
                    "data_points": chem_eval["details"]
                },
                "NLP Match (Embeddings)": {
                    "confidence": f"{nlp_eval['score']:.1f}%",
                    "data_points": nlp_eval["details"]
                },
                "Genetics/Lineage (DB Check)": {
                    "confidence": f"{genetics_eval['score']:.1f}%",
                    "data_points": genetics_eval["details"]
                }
            }
        }
        
        return report

if __name__ == "__main__":
    # --- DEMO 1: A Highly Accurate Sample ---
    good_sample = {
        "sample_id": "SSH-Batch-001",
        "lineage": "Skunk #1 x Northern Lights #5 x Haze",
        "thc": 21.5,
        "terpenes": ["Terpinolene", "Myrcene"],
        "extracted_visuals": ["silver_trichomes", "elongated_colas", "tall_structure", "red_leaves"],
        "description": "Very energetic and cerebral high. Tastes like citrus and earthy pine."
    }
    report1 = PhenotypeMatcher.generate_report(good_sample, SSH_BASELINE)
    print(json.dumps(report1, indent=2))

    # --- DEMO 2: A Mismatched Sample ---
    bad_sample = {
        "sample_id": "Mystery-Seed-002",
        "lineage": "Unknown",
        "thc": 14.0,
        "terpenes": ["Linalool", "Pinene"],
        "extracted_visuals": ["short_bushy", "purple_leaves"],
        "description": "Sleepy, heavy couch-lock effect. Smells like lavender."
    }
    report2 = PhenotypeMatcher.generate_report(bad_sample, SSH_BASELINE)
    print(json.dumps(report2, indent=2))
