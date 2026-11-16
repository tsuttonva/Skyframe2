#!/usr/bin/env python3
"""
For each ATC facility in index.html, count trail miles and park acreage
within 10 miles, using OpenStreetMap (free, no account or API key).

Usage:  python3 osm_counts.py
Needs:  Python 3 only (no pip installs).
Output: osm_trails_parks.csv in the folder you run it from.
Runs one airport at a time (the free server throttles faster requests) and skips airports already in the CSV, so you can stop and re-run safely.
"""
import concurrent.futures
import csv
import json
import math
import os
import time
import urllib.parse
import urllib.request

RADIUS_M = 16093  # 10 miles
OVERPASS = "https://overpass-api.de/api/interpreter"
OUT = "osm_trails_parks.csv"  # written to the folder you run the script from


# Airport codes and coordinates (50 facilities). Embedded so this script does not depend on index.html.
FACILITIES = [
    ("BNA", 36.1245, -86.6782),
    ("TEB", 40.8501, -74.0608),
    ("ORF", 36.8946, -76.2012),
    ("SAV", 32.1276, -81.2021),
    ("AVP", 41.3385, -75.7234),
    ("MDT", 40.1935, -76.7634),
    ("EWR", 40.6895, -74.1745),
    ("JFK", 40.6413, -73.7781),
    ("A80", 33.6407, -84.4277),
    ("CHS", 32.8986, -80.0405),
    ("BOS", 42.3656, -71.0096),
    ("DCA", 38.8512, -77.0402),
    ("MYR", 33.6797, -78.9283),
    ("FAY", 34.9912, -78.8803),
    ("HEF", 38.7212, -77.515),
    ("JAX", 30.4941, -81.6879),
    ("CAE", 33.9388, -81.1195),
    ("PHL", 39.8719, -75.2411),
    ("GSO", 36.0978, -79.9373),
    ("IAD", 38.9531, -77.4565),
    ("ACY", 39.4576, -74.5772),
    ("ATL", 33.6407, -84.4277),
    ("RDU", 35.8776, -78.7875),
    ("TPA", 27.9755, -82.5332),
    ("CLT", 35.214, -80.9431),
    ("ROA", 37.3255, -79.9754),
    ("PCT", 38.7135, -77.795),
    ("TYS", 35.811, -83.994),
    ("MCO", 28.4294, -81.3089),
    ("LGA", 40.7769, -73.874),
    ("ERI", 42.0831, -80.1783),
    ("RIC", 37.5052, -77.3197),
    ("GSP", 34.8957, -82.2189),
    ("ADW", 38.8108, -76.867),
    ("PIT", 40.4915, -80.2329),
    ("BWI", 39.1754, -76.6683),
    ("ILM", 34.2706, -77.9026),
    ("FLL", 26.0726, -80.1527),
    ("MEM", 35.0424, -89.9767),
    ("CHA", 35.0353, -85.2038),
    ("AGS", 33.3699, -81.9645),
    ("ABE", 40.6521, -75.4408),
    ("PNE", 40.0819, -75.0107),
    ("PHF", 37.1319, -76.493),
    ("PDK", 33.8756, -84.302),
    ("AVL", 35.4362, -82.5418),
    ("CLE", 41.4117, -81.8498),
    ("TRI", 36.4787, -82.4074),
    ("AGC", 40.3544, -79.9302),
    ("RDG", 40.3785, -75.9652),
]


def load_facilities():
    """Use facilities.csv (columns: code,lat,lon) if it sits next to this script; otherwise the built-in 50."""
    if os.path.exists("facilities.csv"):
        with open("facilities.csv", newline="", encoding="utf-8") as f:
            return [(r["code"].strip(), float(r["lat"]), float(r["lon"]))
                    for r in csv.DictReader(f) if r.get("code") and r.get("lat") and r.get("lon")]
    return list(FACILITIES)


def haversine_mi(lat1, lon1, lat2, lon2):
    R = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def polygon_acres(geom):
    """Approximate area of a closed way (shoelace on a local flat projection)."""
    if len(geom) < 4 or geom[0] != geom[-1]:
        return 0.0
    lat0 = sum(p["lat"] for p in geom) / len(geom)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    xy = [(p["lon"] * kx, p["lat"] * ky) for p in geom]
    area = 0.0
    for (x1, y1), (x2, y2) in zip(xy, xy[1:]):
        area += x1 * y2 - x2 * y1
    return abs(area) / 2 / 4046.86  # square meters -> acres


def query(lat, lon):
    q = (
        "[out:json][timeout:90];("
        f'way(around:{RADIUS_M},{lat},{lon})["highway"~"^(path|cycleway|bridleway|track)$"];'
        f'way(around:{RADIUS_M},{lat},{lon})["leisure"~"^(park|nature_reserve)$"];'
        ");out tags geom;"
    )
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "atc-explorer-osm-script"})
    with urllib.request.urlopen(req, timeout=150) as f:
        return json.load(f)["elements"]


def summarize(elements):
    trail_mi = 0.0
    park_acres = 0.0
    park_ways = 0
    for el in elements:
        geom = el.get("geometry", [])
        tags = el.get("tags", {})
        if "highway" in tags:
            for a, b in zip(geom, geom[1:]):
                trail_mi += haversine_mi(a["lat"], a["lon"], b["lat"], b["lon"])
        elif "leisure" in tags:
            park_ways += 1
            park_acres += polygon_acres(geom)
    return trail_mi, park_acres, park_ways


def done_codes():
    """Airports already in the CSV with a real result (failed rows get retried)."""
    if not os.path.exists(OUT):
        return set()
    with open(OUT, newline="", encoding="utf-8") as f:
        return {r["code"] for r in csv.DictReader(f) if r.get("trail_miles_10mi")}


def fetch(item):
    code, lat, lon = item
    for attempt in range(4):
        try:
            trail, acres, n = summarize(query(lat, lon))
            time.sleep(5)  # pause between airports so the free server doesn't throttle us
            return code, [code, round(trail, 1), round(acres), n, ""], f"{code}: {trail:.0f} trail mi, {acres:.0f} park acres"
        except Exception as e:
            if attempt == 3:
                return code, [code, "", "", "", f"failed: {e}"], f"{code}: FAILED ({e})"
            # Back off longer when the server says "too many requests"
            time.sleep(60 if "429" in str(e) else 20)


def main():
    facilities = load_facilities()
    finished = done_codes()
    todo = [f for f in facilities if f[0] not in finished]
    print(f"Found {len(facilities)} facilities, {len(finished)} already done, {len(todo)} to run (one at a time)")

    new_file = not os.path.exists(OUT) or not finished
    # Rewrite the file with the kept rows, then append new results as they finish.
    kept = []
    if os.path.exists(OUT) and finished:
        with open(OUT, newline="", encoding="utf-8") as f:
            kept = [r for r in csv.DictReader(f) if r["code"] in finished]
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["code", "trail_miles_10mi", "park_acres_10mi", "park_areas_10mi", "note"])
        for r in kept:
            w.writerow([r["code"], r["trail_miles_10mi"], r["park_acres_10mi"], r["park_areas_10mi"], r["note"]])
        f.flush()
        count = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            futures = [pool.submit(fetch, item) for item in todo]
            for fut in concurrent.futures.as_completed(futures):
                code, row, msg = fut.result()
                w.writerow(row)
                f.flush()
                count += 1
                print(f"{count:2d}/{len(todo)} {msg}")
    print(f"Done. Wrote {OUT}")


if __name__ == "__main__":
    main()
