#!/usr/bin/env python3
# Builds web/airports_nasr.json from an FAA NASR APT_BASE.csv (28-day subscription).
# Usage: python3 scripts/build-airport-nasr.py /path/to/APT_BASE.csv
#
# Keyed by ICAO_ID when present, else the FAA LID (ARPT_ID) -- this matches
# the `ident` field already used in web/airports.json (OurAirports data).
# Value tuple: [useLabel, elevFt, artcc, fss, activationDate]
import csv
import json
import sys

USE_LABELS = {'PU': 'Public', 'PR': 'Private'}


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: build-airport-nasr.py /path/to/APT_BASE.csv')

    out = {}
    with open(sys.argv[1], newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            ident = row['ICAO_ID'].strip() or row['ARPT_ID'].strip()
            if not ident:
                continue

            use = USE_LABELS.get(row['FACILITY_USE_CODE'].strip())

            elev = None
            if row['ELEV'].strip():
                elev = round(float(row['ELEV']))

            artcc = None
            if row['RESP_ARTCC_ID'].strip():
                artcc = row['RESP_ARTCC_ID'].strip()
                if row['ARTCC_NAME'].strip():
                    artcc += ' - ' + row['ARTCC_NAME'].strip().title()

            fss = None
            if row['FSS_ID'].strip():
                fss = row['FSS_ID'].strip()
                if row['FSS_NAME'].strip():
                    fss += ' - ' + row['FSS_NAME'].strip().title()

            activation = row['ACTIVATION_DATE'].strip() or None

            out[ident] = [use, elev, artcc, fss, activation]

    with open('web/airports_nasr.json', 'w') as f:
        json.dump(out, f, separators=(',', ':'))

    print('Wrote {} airport records to web/airports_nasr.json'.format(len(out)))


if __name__ == '__main__':
    main()
