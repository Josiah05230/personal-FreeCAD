#!/usr/bin/env python3
"""One-time import of the company's existing "Part Number Key.xlsx" (the
Google Sheet export this whole PN manager replaces) into gwtcad.partnumbers'
git-backed registry format. Run once per company, not part of the app or the
sidecar - after this, registry.csv in git is the source of truth and the
spreadsheet is no longer edited.

Usage:
    python3 import_pn_registry.py "Part Number Key.xlsx" /path/to/gwt-pn-registry

Writes (or overwrites) registry.csv and types.yaml inside the registry repo
path given. Does NOT commit - review the diff yourself before committing,
since this is exactly the kind of one-shot data migration you want to eyeball
first.

Expected input shape (matches the sheet this was built against):
  - sheet "PartASM Type": columns (Component Type, Prefix Value, Component
    Type Desc.) -> types.yaml
  - sheet "Project": columns (Project Name, Prefix Value, Project Description)
    -> printed as a suggested company.json projects block (repo paths are
    NOT in the sheet - you fill those in yourself, this script can't guess
    where each project's git repo will live on disk)
  - sheet "Total Part Numbers": columns (Component Name, Project Prefix
    Value, Part Type Prefix, Part Index, Revision, Part Number, Revision
    Description, Rev Date, MFG, MFG PN, Purchasing Link, Latest Rev, Status)
    -> one registry.csv row per revision. Component Name becomes
    `description` (the sheet has no separate short "name" field - Name is
    left blank on import; fill it in later via the PN Browser or by hand).
    Status: "Released"+Latest Rev "Yes" -> active, "Obsolete" -> obsolete.
    Blank template rows (no Component Name) are skipped.
"""
import csv
import sys

import openpyxl


_REGISTRY_FIELDS = [
    "pn", "pn_seq", "project", "type", "seq", "rev", "name", "description",
    "reason", "mfg", "mfg_pn", "purchasing_link", "status", "lifecycle",
    "rev_date", "created", "repo_relpath",
]


def _cell(v):
    return "" if v is None else str(v).strip()


def import_types(ws):
    rows = list(ws.iter_rows(values_only=True))[1:]  # skip header
    types = {}
    for name, letter, _desc in rows:
        if not letter or not _cell(name):
            continue
        types[_cell(letter)] = _cell(name)
    return types


def import_projects(ws):
    rows = list(ws.iter_rows(values_only=True))[1:]
    projects = {}
    for name, code, desc in rows:
        if not _cell(name) or not _cell(code) or _cell(name) == "NA":
            continue
        projects[_cell(code)] = {"name": _cell(name), "description": _cell(desc)}
    return projects


def import_part_numbers(ws):
    header = [_cell(c) for c in next(ws.iter_rows(values_only=True))]
    idx = {h: i for i, h in enumerate(header)}
    rows = []
    for r in ws.iter_rows(values_only=True, min_row=2):
        name = r[idx["Component Name"]]
        if not _cell(name):
            continue  # blank template row
        project = _cell(r[idx["Project Prefix Value"]])
        ptype = _cell(r[idx["Part Type Prefix"]])
        seq = _cell(r[idx["Part Index"]])
        rev_raw = r[idx["Revision"]]
        rev = str(int(rev_raw)) if rev_raw is not None else "0"
        pn = _cell(r[idx["Part Number"]])
        reason = _cell(r[idx["Revision Description"]]) or (
            "Initial revision" if rev == "0" else ""
        )
        rev_date = r[idx["Rev Date"]]
        rev_date = rev_date.isoformat() if hasattr(rev_date, "isoformat") else _cell(rev_date)
        mfg = _cell(r[idx["MFG"]])
        mfg_pn = _cell(r[idx["MFG PN"]])
        link = _cell(r[idx["Purchasing Link"]])
        sheet_status = _cell(r[idx["Status"]])
        status = "active" if sheet_status == "Released" else "obsolete"
        rows.append({
            "pn": pn, "pn_seq": "%s%s%s" % (project, ptype, seq), "project": project,
            "type": ptype, "seq": seq, "rev": rev, "name": "",
            "description": _cell(name), "reason": reason, "mfg": mfg,
            "mfg_pn": mfg_pn, "purchasing_link": link, "status": status,
            # The source spreadsheet has no lifecycle concept - these are all
            # pre-existing, already-in-use parts, not fresh reservations, so
            # they import as "active" rather than "in_work".
            "lifecycle": "active",
            "rev_date": rev_date, "created": rev_date, "repo_relpath": "%s.FCStd" % pn,
        })
    return rows


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    xlsx_path, registry_dir = sys.argv[1], sys.argv[2]

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    types = import_types(wb["PartASM Type"])
    projects = import_projects(wb["Project"])
    rows = import_part_numbers(wb["Total Part Numbers"])

    import os
    import yaml

    with open(os.path.join(registry_dir, "types.yaml"), "w") as f:
        yaml.safe_dump(types, f, sort_keys=True, allow_unicode=True)

    with open(os.path.join(registry_dir, "registry.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_REGISTRY_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow(row)

    print("Wrote types.yaml (%d types) and registry.csv (%d revision rows) to %s"
          % (len(types), len(rows), registry_dir))
    print()
    print("Projects found in the sheet (repo paths are NOT in the sheet - add them")
    print("yourself via Company Directories in the app, or by hand in company.json):")
    for code, info in projects.items():
        print("  %s: %s - %s" % (code, info["name"], info["description"][:80]))


if __name__ == "__main__":
    main()
