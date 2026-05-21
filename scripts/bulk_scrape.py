"""
Bulk scraper for Kannapedia strain data.

Uses plain HTTP (requests + BeautifulSoup) — no Playwright needed.
Scrapes strain pages and writes CSV files in the format expected by
data_loader.load_strain_data_from_directory().

Usage:
    python scripts/bulk_scrape.py --output data/plants --limit 150
"""

import argparse
import csv
import os
import re
import sys
import time
import logging

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

BASE_URL = "https://kannapedia.net"
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "CannabisResearcher/1.0 (academic research)",
})


# ── Index scraper ─────────────────────────────────────────────
def get_all_rsp_numbers() -> list[dict]:
    """Fetch the full strain index and extract RSP numbers + names."""
    log.info("Fetching strain index from %s/strains", BASE_URL)
    resp = SESSION.get(f"{BASE_URL}/strains", timeout=30)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    strains = []
    seen = set()

    # Find all strain links
    for link in soup.find_all("a", href=re.compile(r"/strains/rsp\d+")):
        href = link.get("href", "")
        m = re.search(r"/strains/(rsp\d+)", href)
        if not m:
            continue
        rsp = m.group(1)
        if rsp in seen:
            continue
        seen.add(rsp)

        name = link.get_text(strip=True)
        if not name or len(name) < 2:
            continue

        strains.append({"rsp": rsp, "name": name})

    log.info("Found %d unique strains in index", len(strains))
    return strains


# ── Single strain scraper ─────────────────────────────────────
def scrape_strain(rsp: str) -> dict | None:
    """Scrape a single strain page and return structured data."""
    url = f"{BASE_URL}/strains/{rsp}"
    try:
        resp = SESSION.get(url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        log.warning("Failed to fetch %s: %s", url, e)
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    data = {
        "rsp": rsp.upper(),
        "name": "",
        "metadata": {},
        "cannabinoids": {},
        "terpenoids": {},
        "relationships": [],
        "blockchain": {},
    }

    # ── Name ──
    title = soup.find("h1")
    if title:
        data["name"] = title.get_text(strip=True)
    if not data["name"]:
        data["name"] = rsp.upper()

    # ── General info from dt/dd pairs ──
    for section_header in soup.find_all("h2"):
        if "General Information" in section_header.get_text():
            parent = section_header.parent
            if parent:
                dts = parent.find_all("dt")
                dds = parent.find_all("dd")
                for dt, dd in zip(dts, dds):
                    key = dt.get_text(strip=True)
                    val = dd.get_text(strip=True)
                    if key and val:
                        data["metadata"][key] = val

    # ── Grower ──
    grower_el = soup.find(class_="StrainInfo--grower")
    if grower_el:
        grower_text = grower_el.get_text(strip=True)
        data["metadata"]["Grower"] = grower_text.replace("Grower:", "").strip()

    # ── Sex ──
    for link in soup.find_all("a", href=re.compile(r"\?sex=")):
        data["metadata"]["Reported Sex"] = link.get_text(strip=True)

    # ── Report type ──
    for link in soup.find_all("a", href=re.compile(r"\?report=")):
        data["metadata"]["Report Type"] = link.get_text(strip=True)

    # ── Rarity ──
    for link in soup.find_all("a", href=re.compile(r"\?rarity=")):
        data["metadata"]["Rarity"] = link.get_text(strip=True)

    # ── Chemical information ──
    for section_header in soup.find_all("h2"):
        if "Chemical" in section_header.get_text():
            parent = section_header.parent
            if not parent:
                continue

            # Look for h3 sub-sections
            for h3 in parent.find_all("h3"):
                h3_text = h3.get_text(strip=True).lower()
                sub_parent = h3.parent
                if not sub_parent:
                    continue

                dts = sub_parent.find_all("dt")
                dds = sub_parent.find_all("dd")
                for dt, dd in zip(dts, dds):
                    name = dt.get_text(strip=True)
                    val = dd.get_text(strip=True)
                    if val in ("n/a", "") or "no information" in val.lower():
                        continue
                    if "cannabinoid" in h3_text:
                        data["cannabinoids"][name] = val
                    elif "terpenoid" in h3_text:
                        data["terpenoids"][name] = val

    # ── Genetic relationships ──
    # Pattern: distance + strain link pairs in ordered lists
    all_ol = soup.find_all("ol")
    current_type = "all_samples"
    type_idx = 0
    type_names = ["all_samples", "base_tree", "most_distant"]

    for ol in all_ol:
        rel_type = type_names[min(type_idx, len(type_names) - 1)]
        for li in ol.find_all("li"):
            text = li.get_text(strip=True)
            link = li.find("a", href=re.compile(r"/strains/rsp\d+"))
            if not link:
                continue

            # Extract distance (number at the start)
            dist_match = re.search(r"(\d+\.\d+)", text)
            if not dist_match:
                continue

            distance = float(dist_match.group(1))
            strain_text = link.get_text(strip=True)

            # Extract RSP from the link text or href
            rsp_match = re.search(r"\(RSP(\d+)\)", strain_text)
            rel_rsp = f"RSP{rsp_match.group(1)}" if rsp_match else ""

            # Clean strain name (remove RSP suffix)
            rel_name = re.sub(r"\s*\(RSP\d+\)$", "", strain_text).strip()

            data["relationships"].append({
                "type": rel_type,
                "distance": distance,
                "strain": rel_name,
                "rsp": rel_rsp,
            })
        type_idx += 1

    # ── Blockchain ──
    for section_header in soup.find_all("h2"):
        if "Blockchain" in section_header.get_text():
            parent = section_header.parent
            if parent:
                links = parent.find_all("a", href=re.compile(r"blockcypher"))
                if links:
                    data["blockchain"]["txid"] = links[0].get_text(strip=True)
                code = parent.find("code") or parent.find("pre")
                if code:
                    data["blockchain"]["shasum"] = code.get_text(strip=True)

    return data


# ── CSV writer ────────────────────────────────────────────────
def save_strain_csvs(data: dict, output_dir: str) -> None:
    """Save scraped strain data as CSV files in the data_loader format."""
    safe_name = data["name"].replace(" ", "_").replace("/", "_")
    rsp_lower = data["rsp"].lower()
    dir_name = f"{safe_name}-{rsp_lower}"
    strain_dir = os.path.join(output_dir, dir_name)
    os.makedirs(strain_dir, exist_ok=True)

    # Metadata CSV
    meta_path = os.path.join(strain_dir, f"{safe_name}.metadata.csv")
    with open(meta_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Field", "Value"])
        for key, value in data["metadata"].items():
            writer.writerow([key, value])

    # Chemicals CSV
    chem_path = os.path.join(strain_dir, f"{safe_name}.chemicals.csv")
    with open(chem_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Type", "Name", "Value"])
        for name, value in data["cannabinoids"].items():
            writer.writerow(["Cannabinoid", name, value])
        for name, value in data["terpenoids"].items():
            writer.writerow(["Terpenoid", name, value])

    # Variants CSV
    var_path = os.path.join(strain_dir, f"{safe_name}.variants.csv")
    with open(var_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Type", "Distance", "Strain", "RSP"])
        for rel in data["relationships"]:
            writer.writerow([rel["type"], rel["distance"], rel["strain"], rel["rsp"]])

    # Summary text
    summary_path = os.path.join(strain_dir, f"{safe_name}_summary.txt")
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(f"{'='*80}\n")
        f.write(f"{data['name']} ({data['rsp']}) Summary\n")
        f.write(f"{'='*80}\n\n")
        f.write("GENERAL INFORMATION\n")
        f.write(f"{'-'*80}\n")
        for key, value in data["metadata"].items():
            f.write(f"{key}: {value}\n")
        f.write(f"\nCHEMICAL CONTENT\n")
        f.write(f"{'-'*80}\n")
        f.write("Cannabinoids:\n")
        for name, value in data["cannabinoids"].items():
            f.write(f"  {name}: {value}\n")
        f.write("Terpenoids:\n")
        for name, value in data["terpenoids"].items():
            f.write(f"  {name}: {value}\n")
        f.write(f"\nGENETIC RELATIONSHIPS\n")
        f.write(f"{'-'*80}\n")
        for rel in data["relationships"][:20]:
            f.write(f"  {rel['distance']:.3f} - {rel['strain']} ({rel['rsp']})\n")
        if data["blockchain"]:
            f.write(f"\nBLOCKCHAIN INFORMATION\n")
            f.write(f"{'-'*80}\n")
            for key, value in data["blockchain"].items():
                f.write(f"{key}: {value}\n")


def main():
    parser = argparse.ArgumentParser(description="Bulk scrape Kannapedia strains")
    parser.add_argument("--output", default="data/plants", help="Output directory")
    parser.add_argument("--limit", type=int, default=150, help="Max strains to scrape")
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between requests")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    # Get all RSP numbers from the index
    all_strains = get_all_rsp_numbers()

    # Also add well-known strains from existing relationships
    known_rsps = set()
    for s in all_strains:
        known_rsps.add(s["rsp"])

    scraped = 0
    failed = 0
    total_rels = 0

    for i, strain_info in enumerate(all_strains[: args.limit]):
        rsp = strain_info["rsp"]
        name = strain_info["name"]

        # Check if already scraped
        safe_name = name.replace(" ", "_").replace("/", "_")
        dir_name = f"{safe_name}-{rsp}"
        if os.path.isdir(os.path.join(args.output, dir_name)):
            log.info("[%d/%d] SKIP %s (%s) — already exists", i + 1, args.limit, name, rsp)
            scraped += 1
            continue

        log.info("[%d/%d] Scraping %s (%s)...", i + 1, args.limit, name, rsp)
        data = scrape_strain(rsp)

        if not data or not data["name"]:
            log.warning("  → Failed or empty")
            failed += 1
            time.sleep(args.delay)
            continue

        save_strain_csvs(data, args.output)
        rels = len(data["relationships"])
        total_rels += rels
        scraped += 1
        log.info(
            "  → %s: %d cannabinoids, %d terpenoids, %d relationships",
            data["name"],
            len(data["cannabinoids"]),
            len(data["terpenoids"]),
            rels,
        )

        time.sleep(args.delay)

    log.info("=" * 60)
    log.info("Done! Scraped %d strains (%d failed), %d total relationships", scraped, failed, total_rels)
    log.info("Output: %s", os.path.abspath(args.output))


if __name__ == "__main__":
    main()
