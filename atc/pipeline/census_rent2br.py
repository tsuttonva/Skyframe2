import csv, json, urllib.request

KEY = "PASTE_KEY_HERE"  # same Census API key as before

# State FIPS codes (50 states, DC, Puerto Rico)
STATES = [1,2,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,44,45,46,47,48,49,50,51,53,54,55,56,72]

# B25031_004E = median gross rent, 2-bedroom units (ACS 5-year)
VAR = "B25031_004E"

def fetch_year(year):
    header, rows = None, []
    for st in STATES:
        url = (f"https://api.census.gov/data/{year}/acs/acs5"
               f"?get=NAME,{VAR}&for=place:*&in=state:{st:02d}&key={KEY}")
        data = json.load(urllib.request.urlopen(url, timeout=60))
        if header is None:
            header = data[0]
        rows.extend(data[1:])
    return rows

rows = None
for year in (2024, 2023):
    try:
        rows = fetch_year(year)
        print("Using ACS 5-year", year)
        break
    except Exception as e:
        print("ACS", year, "failed:", e)

if not rows:
    raise SystemExit("No data downloaded. Check your key and internet connection.")

with open("census_rent2br.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["NAME", "median_gross_rent_2br", "state", "place"])
    w.writerows(rows)

print(f"Wrote census_rent2br.csv with {len(rows)} places")
