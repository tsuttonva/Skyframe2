# ATC Explorer: handoff for Claude Code

Goal: turn the single-page ATC tower comparison into a GitLab project with
(1) named, per-user saved scenarios that are private by default,
(2) share links that show a scenario's full output (map, scores, slider settings),
(3) an automated data refresh for fast-changing fields (vacancies/staffing, training success),
while static cost-of-living data stays as is.

Reference model: the skyframe2 project already on GitLab. Match its structure and deploy setup.

## 1. What is in this folder

- `app/index.html`: the current working app (version 23 on the Artifact host). Everything is in one file:
  - `const RAW = [...]`: 209 towers, 16 fields each (see section 3).
  - `const TRAIN`, `const INCOME`, `const OUTDOOR`, `const MAP`, `const WARR`: other embedded data.
  - All scoring, filtering, sliders, table, compare panel, map, and zoom logic.
- `data/tracon_tower_list.csv`: 123ATC facility list (292 rows, incl. TRACONs and ARTCCs). Source of target, staffing, level, entry pay.
- `data/training_success.csv`: 123ATC "Training Success Rate (Avg)" plus target, staffing, level, entry pay. 313 rows. This is the refresh target.
- `data/city_join.csv`: 209 rows. Zillow city rent (ZORI), city home value (ZHVI), Census median household income, match type (direct/proxy/none).
- `data/city_crime.csv`: FBI 2024 violent crime per 100k by agency, with flags.
- `data/agency_2024.json`: 26,136 FBI agencies, 2024 totals (violent, murder, rape, robbery, aggravated assault, population).
- `data/rent2br_match.json`: Census 2-bedroom median gross rent (ACS), keyed by facility code.
- `data/worklist.csv`: facility to Census region/division map.
- `pipeline/osm_counts.py`: trail miles and park acres within 10 miles of each airport (OpenStreetMap Overpass). Reads `facilities.csv` if present. Use one worker with 60s backoff on 429s.
- `pipeline/census_income.py`, `pipeline/census_rent2br.py`: Census ACS 5-year pulls. Need a Census API key.
- `pipeline/codes.txt`: the 159 added towers (levels 4-7) plus the original 50.
- `map/build_map.mjs`, `map/coords.json`, `map/map.json`: US state outlines (us-atlas, Albers projection) and facility coordinates. `map.json` is what the page embeds.
- `pipeline` and `map` scripts are Node/Python. Re-run them only if the source data changes.

## 2. Data sources and refresh policy

| Field | Source | Refresh |
|---|---|---|
| Level, CRWG target, current staffing % (Cur Staff), Min CPC pay | 123ATC facilities table | **Frequent** (vacancies change). Target: weekly or nightly. |
| Training success % | 123ATC facility pages/table | **Frequent**. Weekly. |
| Political lean, sports identity | Hand-entered, incomplete (lean 180 of 209 blank, sports 159 blank) | Static |
| Crime (violent per 100k) | FBI UCR 2024 (ICPSR 39664) | Annual (next: 2025 data) |
| Rent (2BR gross) | Census ACS 5-year | Annual |
| Home value (ZHVI), city rent (ZORI) | Zillow, city level | Annual or quarterly. Currently Sept 2026. |
| Median household income | Census ACS B19013 | Annual |
| Trail miles, park acres | OpenStreetMap, 10-mile radius | Rarely. Yearly is fine. |
| Coordinates | facilities.csv / OSM | Static |

Stop rules for the refresh:
- Check 123ATC's terms of use before automating. The site is public, but confirm scraping is allowed, keep request rates low, and identify the bot. If scraping isn't allowed, ask Joslyn/Dani to request a data export or find another source.
- Each refresh must write the changed fields to a dated snapshot file. Never overwrite a field with blank. Keep the last good value and flag it stale.

## 3. RAW row schema (index.html)

`[code, name, st, inR, level, target, staff, index, entry, crime, home, rent2, lean, sports, lat, lon]`

- `staff`: current staffing as a whole-number percent (for example 75 = 75%).
- `index`: price index vs. the national average (blank for the 159 added towers).
- `entry`: Min CPC pay (dollars).
- `crime`: violent per 100k (FBI 2024). Blank for 35 towers. See section 5.
- `home`: median home value. `rent2`: 2BR rent. `lean`: political lean. `sports`: sports identity.
- Separate maps: `TRAIN[code]` (training success %), `INCOME[code]`, `OUTDOOR[code] = [trailMiles, parkAcres]`.

Derived in JS (keep these in code, not in the data):
- `colDelta = (index / WARR.index - 1) * 100`
- `miles`: haversine from Warrenton (38.7135, -77.7950).
- `trainee = entry * 0.575`; `net` (after federal/state/FICA approximations); `afterRent = net - rent2`; `rentPct`.
- `safetyGrade(crime)`: A < 150, B < 300, C < 500, D < 800, else F.

## 4. Scoring (keep the behavior)

- Each category converts to a percentile across scored towers. Higher is better except where noted.
- Categories and default weights (sum 100, a fixed pool): pay (afterRent, 25), afford (rent2 lower is better, 25), safe (crime lower is better, 20), close (miles lower is better, 10), need (staff lower is better, 10), outdoors (average of trail and park percentiles, 10), training (training success, 0 by default).
- Fit score shows only when at least 60% of the weight has data. Otherwise the dot is gray.
- Level filter: towers above the chosen max level are dimmed and sorted to the bottom in the table. On the map, they are hidden.
- Max staffed filter: a hard cut.
- Compare panel: up to 3 towers, best value bolded per row.

## 5. Known gaps (be honest about these in the UI)

- Crime blank for 35 towers:
  - 25 are "proxy" airports where a nearby big city's figure was borrowed. These are left blank on purpose. Teterboro (NYC), Hanscom (Boston), and others. Keep them blank or label them as borrowed.
  - 4 report zero offenses to the FBI (GPT, JAN, NEW, ORL). Looks wrong. Blank.
  - 2 Hawaii agencies (ITO, OGG) have no population figure. Blank.
  - SJU and STT are outside the FBI file. Blank.
- 2BR rent: Census gross rent (includes utilities) for 204 towers. The original 50 use RentCafe asking rents, which run about 20% higher. The page has a footnote. Don't mix the two without a note.
- SJU and STT are not on the US map.
- Political lean and sports blank for most new towers.
- Price index blank for the 159 added towers. The Cost vs Warrenton column shows a dash.
- Teterboro income/rent use a proxy.
- Savannah crime (SAV) looks suspiciously low; the app keeps an earlier NeighborhoodScout value (355). Verify before trusting.
- Facility-level ATC sentiment: not found. Reddit blocked, Glassdoor not per facility.
- Training success month differs by facility (Aug to Oct 2026). Small classes swing to 100% or 0%. Footnote states this.

## 6. Build plan for the new app

### 6a. Structure
- GitLab project `atc-explorer` (match skyframe2: same CI, same Pages setup if used).
- Split the single file into `data/*.json` (generated), `src/` (JS/CSS), and `index.html`. Keep the current app working during the migration.
- A build step that generates `data/facilities.json` from `data/` CSVs and the refresh snapshots.

### 6b. Saved scenarios and sharing (the hard part)
- A static GitLab Pages site cannot hold private per-user data. Add a small back end. Options, lowest effort first:
  1. Supabase or Firebase (auth + database) with the front end talking to it directly. Row-level security enforces "private by default."
  2. A small Node/Express or FastAPI service on any host, with GitLab SSO or email login.
- Data model: `users`, `scenarios` (id, owner, name, created, `settings` JSON with weights, filters, selected towers, map view), `shares` (scenario_id, token, created). A share link is `/s/<token>` and is read-only. It shows the saved settings and the computed output (table, map, scores).
- Default: scenarios are private to the owner. Sharing creates an unguessable token. Make revoking a share possible.
- Settings JSON must be enough to recompute the output exactly. Do not store computed scores as the source of truth, since data refreshes change them. Store the data snapshot date with each share so the viewer knows when the numbers were computed.

### 6c. Automated data refresh
- A scheduled GitLab CI job (`schedules`) runs the pull:
  1. Fetch the 123ATC table (weekly or nightly), validate it (row count within ±5% of the last run, no required field suddenly blank), and write a dated snapshot.
  2. Rebuild `data/facilities.json`. Keep values if the new value is blank.
  3. Commit the changed data and trigger a deploy.
- Annual/quarterly jobs for Census, FBI, Zillow, OSM. Manual runs are fine.
- Each run writes a short change log: which towers changed, which fields, old and new values.

### 6d. Validation
- Keep the checks used so far:
  - Two independent reads of the full 123ATC table must agree before a refresh is published.
  - Spot-check 5 to 10 facility pages against the table.
  - App values for level, target, staffing, and entry pay must match 123ATC for all facilities.
- Document these checks in the repo as tests.

## 7. Open questions for the owners (Tom/Joslyn)

- Who signs in, and how? Shared login, email, or GitLab SSO?
- Should share links expire?
- Keep the 25 proxy towers blank, or show them with a "borrowed" label?
- OK to automate the 123ATC pull after checking their terms, or should we request an export?

## 8. Non-goals for now

- Pay accuracy beyond the current approximations (federal/state/FICA estimates). These are not tax advice.
- A "best tower for you" recommendation engine. The app ranks by the user's weights only.
