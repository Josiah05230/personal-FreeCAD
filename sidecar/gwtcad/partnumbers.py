"""Company part-number (PN) manager: assigns/looks up/revises GWT part
numbers against a shared, git-backed registry, and locates the on-disk CAD
files that carry them across a company's per-project git repos.

Layout this module assumes (all paths come from ~/.gwtcad/company.json, none
are hardcoded):
  - one shared "registry" repo holding registry.csv and types.yaml (a
    project-defined type-letter map);
  - one git repo PER PROJECT (keyed by a 2-letter project code), each holding
    the actual .FCStd files. A reusable-hardware library (bolts, magnets, MMC
    connectors, ...) is just an ordinary project with its own code (e.g. HW)
    - there is no separate "hardware" concept in this module; its type
      letters simply happen to be arbitrary/sequential rather than a fixed
      A=Assembly-style map, which is a types.yaml content choice, not a code
      path difference;
  - a PN is "[project][type][seq3][rev1]", e.g. PSA0080. seq is fixed for the
    part's life; a revision bump copies the current file to the next rev
    number - the old rev file is left alone on disk and in git history.

registry.csv holds ONE ROW PER REVISION (not per sequence) - this mirrors the
company's existing tracking spreadsheet, where every revision carries its own
changelog reason, date, and (for purchased/off-the-shelf parts) manufacturer
info that genuinely changes between revisions (e.g. a PCB vendor switch). A
sequence's "current" row is whichever of its rows has the highest rev number;
pn_current_row() below is the one place that logic lives.

Git is the concurrency control: reserving a PN or bumping a revision means
pull -> mutate registry.csv -> commit -> push, retrying against a freshly
pulled registry if the push is rejected (someone else committed first) rather
than trusting an in-memory list to still be current. There is no server/lock
service - a rejected push is the ONLY signal a collision happened, so every
mutating RPC below re-derives its result from a fresh pull rather than reusing
anything read before the pull.
"""
import csv
import os
import shutil
import subprocess

import yaml

from .registry import method, RpcError, APP_ERROR

_CONFIG_PATH = os.path.expanduser("~/.gwtcad/company.json")

# One row per revision. mfg/mfg_pn/purchasing_link are optional (blank for
# self-designed parts, populated where known for purchased/off-the-shelf
# hardware - e.g. auto-filled from a McMaster-Carr import's scraped metadata).
# repo_relpath is only a cached HINT of where <pn>.FCStd last lived within its
# project repo, not authoritative - a file may be organized into subfolders
# and moved freely by hand (Finder, `git mv`, ...), so every lookup verifies
# the hint still exists on disk and falls back to a recursive filename search
# (self-healing the hint) rather than trusting it blindly. See
# _find_part_file below.
#
# `status` (active/obsolete) is auto-computed PER ROW by pn_new_revision - it
# only ever means "is this the current revision of its sequence." `lifecycle`
# is a different axis entirely: a deliberate, human-set PER SEQUENCE (pn_seq)
# state that carries forward across revisions unless explicitly changed (see
# pn_set_lifecycle / pn_new_revision below) - whether this PART, across all
# its revisions, is still a going concern at all.
_REGISTRY_FIELDS = [
    "pn", "pn_seq", "project", "type", "seq", "rev", "name", "description",
    "reason", "mfg", "mfg_pn", "purchasing_link", "status", "lifecycle",
    "rev_date", "created", "repo_relpath",
]

# in_work: just reserved or just revised, not yet validated - can't be
#          published in any downstream ordering system.
# active: validated and a going concern - publishable.
# discontinued: dead - downstream systems should prompt to unpublish/flag it.
_LIFECYCLE_STATES = ("in_work", "active", "discontinued")

_MAX_PUSH_RETRIES = 5


# --------------------------------------------------------------------------- #
# company.json
# --------------------------------------------------------------------------- #

def _load_config():
    if not os.path.exists(_CONFIG_PATH):
        return {"registryPath": None, "projects": {}}
    try:
        import json
        with open(_CONFIG_PATH) as f:
            cfg = json.load(f)
    except Exception:
        return {"registryPath": None, "projects": {}}
    cfg.setdefault("registryPath", None)
    cfg.setdefault("projects", {})
    return cfg


def _save_config(cfg):
    import json
    os.makedirs(os.path.dirname(_CONFIG_PATH), exist_ok=True)
    tmp = _CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, _CONFIG_PATH)


@method("pn.getCompanyConfig")
def pn_get_company_config():
    return _load_config()


@method("pn.setCompanyConfig")
def pn_set_company_config(registryPath=None, projects=None):
    cfg = _load_config()
    if registryPath is not None:
        cfg["registryPath"] = registryPath
    if projects is not None:
        cfg["projects"] = projects
    _save_config(cfg)
    return cfg


def _repo_path_for(cfg, project):
    """Resolve a 2-letter project code to its repo path, raising a clear app
    error if company.json isn't set up for it yet rather than a bare
    KeyError. A reusable-hardware library is just a project like any other -
    there is no special-cased code here for it."""
    entry = (cfg.get("projects") or {}).get(project)
    path = entry.get("repoPath") if entry else None
    if not path or not os.path.isdir(path):
        raise RpcError(APP_ERROR,
                        "project '%s' has no valid repoPath in company.json - "
                        "set up company directories first" % project)
    return path


def _registry_path(cfg):
    path = cfg.get("registryPath")
    if not path or not os.path.isdir(path):
        raise RpcError(APP_ERROR,
                        "no registry repo configured - set up company "
                        "directories first")
    return path


# --------------------------------------------------------------------------- #
# git helpers
# --------------------------------------------------------------------------- #

def _git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args),
                        capture_output=True, text=True)
    if r.returncode != 0:
        raise RpcError(APP_ERROR,
                        "git %s failed in %s: %s" % (" ".join(args), repo, r.stderr.strip()))
    return r.stdout


def _git_ok(repo, *args):
    """Like _git but returns (ok, output) instead of raising - for commands
    whose failure is an expected outcome to branch on (e.g. push rejection)."""
    r = subprocess.run(["git", "-C", repo] + list(args),
                        capture_output=True, text=True)
    return r.returncode == 0, (r.stdout or r.stderr).strip()


def _has_remote(repo):
    ok, out = _git_ok(repo, "remote")
    return ok and bool(out.strip())


def _sync_pull(repo):
    if _has_remote(repo):
        _git(repo, "pull", "--rebase", "--autostash")


def _commit_and_push(repo, message, retry_fn):
    """Stage everything, commit, and push with retry: on a rejected push,
    re-pull and re-run retry_fn (which re-derives the change against the now-
    current registry) before trying again. retry_fn returns True if it made a
    change to commit, False if the desired state already exists (e.g. someone
    else already committed the exact row we wanted)."""
    for attempt in range(_MAX_PUSH_RETRIES):
        _git(repo, "add", "-A")
        # Nothing staged (retry_fn decided no further change is needed) - done.
        ok, _ = _git_ok(repo, "diff", "--cached", "--quiet")
        if ok:
            return
        _git(repo, "commit", "-m", message)
        if not _has_remote(repo):
            return
        ok, _ = _git_ok(repo, "push")
        if ok:
            return
        # Push rejected - someone else committed first. Reset our local
        # commit, re-pull, and let the caller recompute against fresh state.
        _git(repo, "reset", "--soft", "HEAD~1")
        _git(repo, "pull", "--rebase", "--autostash")
        if not retry_fn():
            return
    raise RpcError(APP_ERROR,
                    "could not push to registry after %d retries - "
                    "someone else keeps winning the race" % _MAX_PUSH_RETRIES)


# --------------------------------------------------------------------------- #
# registry.csv - one row per revision
# --------------------------------------------------------------------------- #

def _registry_csv(cfg):
    return os.path.join(_registry_path(cfg), "registry.csv")


def _read_registry(cfg):
    path = _registry_csv(cfg)
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


# bom.csv: one row per kit-item, keyed by the EXACT assembly pn (not
# pn_seq) that was open when the BOM was captured - a snapshot of "what's
# literally in this assembly at this revision," not a live-recomputed
# value. Fully replaced (all of an assembly pn's rows at once) every time
# pn_save_bom runs, since the caller always hands over the complete current
# BOM, never a partial update.
_BOM_FIELDS = ["pn", "item_pn", "item_component_name", "qty"]


def _bom_csv(cfg):
    return os.path.join(_registry_path(cfg), "bom.csv")


def _read_bom(cfg):
    path = _bom_csv(cfg)
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def _write_bom(cfg, rows):
    path = _bom_csv(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_BOM_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in _BOM_FIELDS})
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Purchased-parts inventory - inventory_batches.csv + inventory_log.csv
# --------------------------------------------------------------------------- #
#
# Tracked per EXACT pn (with rev digit), not pn_seq - a revision bump often
# means a different physical part was substituted (a supplier switch is
# exactly what pn.newRevision's `reason` captures), so silently carrying
# stock forward across a revision would misrepresent what's actually on the
# shelf. A revision bump starts that new pn's stock at zero; the OLD pn's
# batches/history stay exactly as they were - nothing here rewrites the past.
#
# FIFO costing: inventory_batches.csv holds one row per purchase, with
# qty_remaining depleting as consumption eats the OLDEST unconsumed batch(es)
# first (see _consume_pn_fifo). qty_on_hand and avg_cost are NEVER stored -
# always derived by summing/averaging whatever batches still have
# qty_remaining > 0, so they can't drift out of sync with the ledger the way
# a separately-cached running total could.
#
# inventory_log.csv is a pure audit trail (append-only, never mutated) of
# every purchase/consumption/adjustment event - "why does this number look
# wrong" should always be answerable by reading it, same spirit as
# registry.csv keeping every revision instead of only the current one.
_INVENTORY_BATCH_FIELDS = [
    "id", "pn", "qty_purchased", "qty_remaining", "unit_cost",
    "purchase_date", "source",
]
_INVENTORY_LOG_FIELDS = [
    "date", "pn", "delta_qty", "unit_cost", "reason", "batch_id",
]


def _inventory_batches_csv(cfg):
    return os.path.join(_registry_path(cfg), "inventory_batches.csv")


def _inventory_log_csv(cfg):
    return os.path.join(_registry_path(cfg), "inventory_log.csv")


def _read_inventory_batches(cfg):
    path = _inventory_batches_csv(cfg)
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def _write_inventory_batches(cfg, rows):
    path = _inventory_batches_csv(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_INVENTORY_BATCH_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in _INVENTORY_BATCH_FIELDS})
    os.replace(tmp, path)


def _append_inventory_log(cfg, entries):
    path = _inventory_log_csv(cfg)
    is_new = not os.path.exists(path)
    with open(path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_INVENTORY_LOG_FIELDS)
        if is_new:
            w.writeheader()
        for entry in entries:
            w.writerow({k: entry.get(k, "") for k in _INVENTORY_LOG_FIELDS})


def _inventory_summary(batches_for_pn):
    """{qtyOnHand, avgCost} derived fresh from a pn's batches - never stored.
    avgCost is the qty_remaining-weighted average unit_cost across batches
    that still have stock; 0 once qty_on_hand hits 0 (nothing left to
    average, not a stale leftover number)."""
    qty_on_hand = sum(int(b.get("qty_remaining") or 0) for b in batches_for_pn)
    if qty_on_hand <= 0:
        return {"qtyOnHand": 0, "avgCost": 0.0}
    total_value = sum(
        int(b.get("qty_remaining") or 0) * float(b.get("unit_cost") or 0)
        for b in batches_for_pn
    )
    return {"qtyOnHand": qty_on_hand, "avgCost": round(total_value / qty_on_hand, 4)}


def _deplete_fifo(all_batch_rows, pn, qty_needed):
    """Mutates all_batch_rows in place, depleting pn's OLDEST (by
    purchase_date) batches with remaining stock first. Returns
    (qty_actually_deducted, log_entries) - qty_actually_deducted may be less
    than qty_needed if this pn doesn't have enough stock (never goes
    negative; the caller decides whether a shortfall is an error or just
    "consumed however much was on hand"). log_entries is one dict per batch
    touched, ready to append to inventory_log.csv."""
    remaining_need = qty_needed
    log_entries = []
    pn_batches = sorted(
        (b for b in all_batch_rows if b.get("pn") == pn and int(b.get("qty_remaining") or 0) > 0),
        key=lambda b: b.get("purchase_date") or "",
    )
    for batch in pn_batches:
        if remaining_need <= 0:
            break
        available = int(batch.get("qty_remaining") or 0)
        take = min(available, remaining_need)
        batch["qty_remaining"] = str(available - take)
        remaining_need -= take
        log_entries.append({
            "date": _now_iso(), "pn": pn, "delta_qty": str(-take),
            "unit_cost": batch.get("unit_cost", ""), "reason": "consumed",
            "batch_id": batch.get("id", ""),
        })
    return qty_needed - remaining_need, log_entries


def _write_registry(cfg, rows):
    path = _registry_csv(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_REGISTRY_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in _REGISTRY_FIELDS})
    os.replace(tmp, path)


def _rows_for_seq(rows, pn_seq):
    return [r for r in rows if r.get("pn_seq") == pn_seq]


def _row_for_pn(rows, pn):
    """The exact row for a full PN (with rev digit, e.g. PSG0080) - unlike
    _current_row, this does NOT resolve to whatever the current rev is; it
    reports the exact revision asked for, or None if that exact PN was never
    reserved. Used for BOM resolution, where "what's literally in this
    assembly" matters more than "what's current" - see pn_bom_for_document."""
    for r in rows:
        if r.get("pn") == pn:
            return r
    return None


def _current_row(rows, pn_seq):
    """The highest-rev row for a sequence - its current state - or None if
    the sequence doesn't exist at all."""
    seq_rows = _rows_for_seq(rows, pn_seq)
    if not seq_rows:
        return None
    return max(seq_rows, key=lambda r: int(r["rev"]))


def _filename_for(project, type, seq, rev):
    return "%s.FCStd" % _fmt_pn(project, type, seq, rev)


def _new_part_relpath(project, type, seq, rev):
    """Where a BRAND NEW part's file should land: <project>/<type>/<pn>/
    <pn>.FCStd (e.g. CM/Z/CMZ0010/CMZ0010.FCStd) - grouped by project then
    type so a person browsing the repo by hand can find a family of parts
    without already knowing its PN, rather than every part sitting in one
    flat, ever-growing folder. Only used for pn.reserve's very first
    placement; pn.newRevision deliberately keeps a later revision NEXT TO
    wherever the current file actually lives (via _find_part_file's
    self-healing search) instead of recomputing this, so a part that's been
    manually reorganized since is never fought with."""
    pn = _fmt_pn(project, type, seq, rev)
    return os.path.join(project, type, pn, "%s.FCStd" % pn)


def _find_part_file(repo, filename, hint_relpath=None):
    """Where <filename> actually lives inside repo. Checks the cached hint
    first (fast path - true almost always, since files don't move on their
    own), then falls back to a recursive search by exact filename so a part
    that got reorganized into a subfolder by hand is still found without any
    registry update. Returns (abspath, relpath) or (None, None) if genuinely
    missing. Search order for the fallback is arbitrary among ties - a
    filename collision (same PN.FCStd in two places) shouldn't happen since
    PNs are unique, but if it ever does, whichever os.walk finds first wins;
    not worth guarding against something that indicates a worse problem."""
    if hint_relpath:
        hint_abs = os.path.join(repo, hint_relpath)
        if os.path.isfile(hint_abs):
            return hint_abs, hint_relpath
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        if filename in filenames:
            abspath = os.path.join(dirpath, filename)
            return abspath, os.path.relpath(abspath, repo)
    return None, None


def _types_yaml(cfg):
    return os.path.join(_registry_path(cfg), "types.yaml")


@method("pn.listTypes")
def pn_list_types():
    """The user-maintained type-letter map (A=Assembly, ...), shared across
    every project via the registry repo. Empty until the user fills it in -
    callers should handle a blank map, not assume it's pre-populated."""
    cfg = _load_config()
    path = _types_yaml(cfg)
    if not os.path.exists(path):
        return {"types": {}}
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    return {"types": {str(k): v for k, v in data.items()}}


def _now_iso():
    import datetime
    return datetime.datetime.now().isoformat(timespec="seconds")


def _current_rows(rows):
    """One row per sequence - each sequence's highest-rev row only. This is
    what "the registry" means for anything that isn't specifically asking
    for revision history."""
    by_seq = {}
    for r in rows:
        seq = r.get("pn_seq")
        if not seq:
            continue
        cur = by_seq.get(seq)
        if cur is None or int(r["rev"]) > int(cur["rev"]):
            by_seq[seq] = r
    return list(by_seq.values())


@method("pn.listAll")
def pn_list_all(project=None, status=None):
    """Current-revision snapshot of every PN sequence (not full history -
    see pn.history for a sequence's past revisions)."""
    cfg = _load_config()
    if not cfg.get("registryPath"):
        return {"parts": []}
    _sync_pull(_registry_path(cfg))
    rows = _current_rows(_read_registry(cfg))
    if project:
        rows = [r for r in rows if r.get("project") == project]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return {"parts": rows}


@method("pn.history")
def pn_history(pnSeq):
    """Every revision ever recorded for a sequence, oldest first."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = _rows_for_seq(_read_registry(cfg), pnSeq)
    rows.sort(key=lambda r: int(r["rev"]))
    return {"revisions": rows}


@method("pn.listAvailableSeq")
def pn_list_available_seq(project, type, count=20):
    """Unused 3-digit sequence numbers for this project+type, filling holes
    left by obsoleted parts rather than only ever going past the highest one
    used - the user picks any free number, not just the next one."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = _read_registry(cfg)
    used = {int(r["seq"]) for r in rows
            if r.get("project") == project and r.get("type") == type and r.get("seq")}
    out = []
    n = 1
    while len(out) < count and n <= 999:
        if n not in used:
            out.append(n)
        n += 1
    return {"available": out}


def _fmt_pn(project, type, seq, rev):
    return "%s%s%03d%d" % (project, type, seq, rev)


# Suppliers whose part number deterministically maps to a working product
# URL, keyed by a lowercased mfg-name match. McMaster-Carr's own catalog
# number IS the URL slug on their site (mcmaster.com/<mfgPn>/); DigiKey's
# and Mouser's search/product endpoints reliably resolve a manufacturer part
# number to its product page; for Amazon, mfg_pn in this registry is always
# the ASIN when mfg=Amazon (confirmed against every existing Amazon row),
# and amazon.com/dp/<ASIN> is Amazon's own canonical product-page scheme.
# This is intentionally a short, explicit list rather than a generic "guess
# a URL" scheme - most suppliers (Heilind, JLCPCB, ...) don't have a
# reliable part-number-to-URL mapping, so those are left blank for a human
# to paste in, same as always.
_AUTO_LINK_BUILDERS = {
    "mcmaster-carr": lambda mfg_pn: "https://www.mcmaster.com/%s/" % mfg_pn,
    "mcmaster":      lambda mfg_pn: "https://www.mcmaster.com/%s/" % mfg_pn,
    "digikey":       lambda mfg_pn: "https://www.digikey.com/en/products/result?keywords=%s" % mfg_pn,
    "mouser":        lambda mfg_pn: "https://www.mouser.com/ProductDetail/%s" % mfg_pn,
    "amazon":        lambda mfg_pn: "https://www.amazon.com/dp/%s" % mfg_pn,
}


def _auto_purchasing_link(mfg, mfg_pn):
    """A generated purchasing link for known suppliers when mfg_pn is given,
    or "" if mfg isn't one of the suppliers we know how to link (the caller
    still just leaves purchasing_link blank in that case, same as before this
    existed)."""
    if not mfg or not mfg_pn:
        return ""
    builder = _AUTO_LINK_BUILDERS.get(mfg.strip().lower())
    if not builder:
        return ""
    from urllib.parse import quote
    return builder(quote(mfg_pn.strip(), safe=""))


@method("pn.reserve")
def pn_reserve(project, type, seq, name, description, mfg=None, mfgPn=None, purchasingLink=None):
    """Assign a brand-new PN at rev 0 and append its row to the registry.
    Rev 0's reason is always "Initial revision" - only later revisions
    require the user to state why. Returns the assigned PN string and the
    relative path the caller should save the new .FCStd at (caller still
    does the actual FreeCAD saveAs - this RPC only reserves the identity).

    If purchasingLink is left blank and mfg is a supplier whose part number
    maps to a real product URL (McMaster-Carr, DigiKey), it's auto-filled
    from mfgPn - see _AUTO_LINK_BUILDERS. An explicitly given purchasingLink
    is never overridden."""
    cfg = _load_config()
    seq = int(seq)
    repo = _registry_path(cfg)
    pn_seq = "%s%s%03d" % (project, type, seq)
    relpath = _new_part_relpath(project, type, seq, 0)
    pn = _fmt_pn(project, type, seq, 0)
    link = purchasingLink or _auto_purchasing_link(mfg, mfgPn)

    def attempt():
        rows = _read_registry(cfg)
        if _rows_for_seq(rows, pn_seq):
            # Someone else already took this exact seq - caller must retry
            # with a fresh pn.listAvailableSeq; nothing for us to commit.
            return False
        rows.append({
            "pn": pn, "pn_seq": pn_seq, "project": project, "type": type,
            "seq": "%03d" % seq, "rev": "0", "name": name or "",
            "description": description, "reason": "Initial revision",
            "mfg": mfg or "", "mfg_pn": mfgPn or "", "purchasing_link": link,
            "status": "active", "lifecycle": "in_work",
            "rev_date": _now_iso(), "created": _now_iso(),
            "repo_relpath": relpath,
        })
        _write_registry(cfg, rows)
        return True

    _sync_pull(repo)
    if not attempt():
        raise RpcError(APP_ERROR,
                        "PN %s was just taken by someone else - pick another "
                        "sequence number" % pn_seq)
    _commit_and_push(repo, "Reserve PN %s (%s)" % (pn, description), attempt)

    return {"pn": pn, "pnSeq": pn_seq, "rev": 0, "repoRelpath": relpath,
            "name": name or "", "description": description}


@method("pn.newRevision")
def pn_new_revision(pnSeq, reason, mfg=None, mfgPn=None, purchasingLink=None):
    """Copy the current-rev file to the next rev number in its project repo,
    append a NEW row for that revision (carrying forward name/description
    unless the caller changed them), and mark the prior top row obsolete.
    reason is required - it's the per-revision changelog note the sheet this
    replaced always carried ('Updated LDO REG...', 'Switched to ESP', ...).
    The OLD rev file is left in place on disk and in git history - this
    never overwrites or deletes it.

    The new row's lifecycle always resets to "in_work" regardless of the
    prior revision's lifecycle (including reviving a "discontinued" part
    with a redesign) - a bumped revision hasn't been validated yet and can't
    be published downstream until pn.setLifecycle marks it "active"."""
    if not reason or not reason.strip():
        raise RpcError(APP_ERROR, "a revision reason is required")
    cfg = _load_config()
    reg_repo = _registry_path(cfg)
    _sync_pull(reg_repo)
    rows = _read_registry(cfg)
    cur = _current_row(rows, pnSeq)
    if cur is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pnSeq)

    project, type, seq = cur["project"], cur["type"], int(cur["seq"])
    old_rev = int(cur["rev"])
    new_rev = old_rev + 1
    proj_repo = _repo_path_for(cfg, project)

    old_filename = _filename_for(project, type, seq, old_rev)
    old_abspath, old_relpath = _find_part_file(proj_repo, old_filename, cur.get("repo_relpath"))
    if old_abspath is None:
        raise RpcError(APP_ERROR,
                        "current rev file %s not found anywhere under %s" % (old_filename, proj_repo))
    # The new revision's file lands NEXT TO the old one (same folder) rather
    # than always at the repo root - preserves whatever organization the
    # project uses (mechanical/, electrical/, ...).
    new_relpath = os.path.join(os.path.dirname(old_relpath), _filename_for(project, type, seq, new_rev))
    new_abspath = os.path.join(proj_repo, new_relpath)
    if os.path.exists(new_abspath):
        raise RpcError(APP_ERROR, "target rev file already exists: %s" % new_abspath)

    _sync_pull(proj_repo)
    shutil.copy2(old_abspath, new_abspath)
    old_companion = old_abspath + ".gwtcad.json"
    if os.path.isfile(old_companion):
        shutil.copy2(old_companion, new_abspath + ".gwtcad.json")
    _commit_and_push(proj_repo, "New revision %s" % os.path.basename(new_relpath),
                      lambda: True)

    def attempt():
        rows2 = _read_registry(cfg)
        cur2 = _current_row(rows2, pnSeq)
        if cur2 is None or int(cur2["rev"]) != old_rev:
            # Someone else already bumped this PN's revision since we
            # started - our copied file is now stale/wrong, surface that.
            raise RpcError(APP_ERROR,
                            "PN %s's revision changed underneath us - retry" % pnSeq)
        cur2["status"] = "obsolete"
        # mfg/mfgPn/purchasingLink carry forward from the prior revision
        # unless explicitly overridden - there's no way to CLEAR one of these
        # via a revision bump (only replace it), since None means "not
        # specified" here rather than "blank it out". Not worth the extra
        # parameter noise for something this rare - edit registry.csv by hand
        # if it's ever actually needed.
        #
        # purchasingLink is resolved AFTER mfg/mfgPn so that changing to a
        # different mfg_pn on this revision (without also repasting a new
        # link) re-generates the link for the NEW part rather than silently
        # carrying forward a link that now points at the wrong product.
        new_mfg    = mfg if mfg is not None else cur2.get("mfg", "")
        new_mfg_pn = mfgPn if mfgPn is not None else cur2.get("mfg_pn", "")
        if purchasingLink is not None:
            new_link = purchasingLink
        elif mfgPn is not None or mfg is not None:
            new_link = _auto_purchasing_link(new_mfg, new_mfg_pn)
        else:
            new_link = cur2.get("purchasing_link", "")
        rows2.append({
            "pn": _fmt_pn(project, type, seq, new_rev), "pn_seq": pnSeq,
            "project": project, "type": type, "seq": cur2["seq"], "rev": str(new_rev),
            "name": cur2.get("name", ""), "description": cur2.get("description", ""),
            "reason": reason.strip(),
            "mfg": new_mfg, "mfg_pn": new_mfg_pn, "purchasing_link": new_link,
            "status": "active", "lifecycle": "in_work",
            "rev_date": _now_iso(), "created": _now_iso(),
            "repo_relpath": new_relpath,
        })
        _write_registry(cfg, rows2)
        return True

    _sync_pull(reg_repo)
    attempt()
    _commit_and_push(reg_repo, "%s: rev %d - %s" % (pnSeq, new_rev, reason.strip()), attempt)

    return {"pn": _fmt_pn(project, type, seq, new_rev), "pnSeq": pnSeq,
            "rev": new_rev, "repoRelpath": new_relpath, "path": new_abspath,
            "name": cur.get("name", ""), "description": cur.get("description", "")}


@method("pn.setLifecycle")
def pn_set_lifecycle(pnSeq, lifecycle):
    """Set a part sequence's lifecycle (in_work / active / discontinued) on
    its CURRENT revision row, without requiring a revision bump - e.g.
    marking a just-validated in_work part active, or a part discontinued.
    Only ever touches the current row; past revisions keep whatever
    lifecycle value they were synced/committed with (a historical snapshot,
    not something that changes retroactively) - pn_new_revision is what
    carries the value forward onto each new row."""
    if lifecycle not in _LIFECYCLE_STATES:
        raise RpcError(APP_ERROR,
                        "lifecycle must be one of %s, got %r" % (_LIFECYCLE_STATES, lifecycle))
    cfg = _load_config()
    reg_repo = _registry_path(cfg)

    def attempt():
        rows = _read_registry(cfg)
        cur = _current_row(rows, pnSeq)
        if cur is None:
            raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pnSeq)
        if cur.get("lifecycle") == lifecycle:
            return False
        cur["lifecycle"] = lifecycle
        _write_registry(cfg, rows)
        return True

    _sync_pull(reg_repo)
    if not attempt():
        return {"pnSeq": pnSeq, "lifecycle": lifecycle, "unchanged": True}
    _commit_and_push(reg_repo, "%s: lifecycle -> %s" % (pnSeq, lifecycle), attempt)
    return {"pnSeq": pnSeq, "lifecycle": lifecycle}


@method("pn.resolveBomFilenames")
def pn_resolve_bom_filenames(filenames):
    """Resolve a list of {"filename": "<PN>.FCStd", "qty": N} entries (one
    per distinct part an assembly's App::Link components point at - see
    methods.drawing_bom_rows for the equivalent CAD-label-based grouping;
    this does the same job keyed by filename/PN instead) against the
    registry.

    Each entry resolves to the EXACT PN implied by its filename if that PN
    was actually ever reserved - not forced to whatever the current revision
    of that sequence is. An assembly that links an old-rev file reports that
    old PN as-is; that's a feature, not a bug - it surfaces a stale assembly
    link rather than silently "correcting" it. A filename with no matching
    registry row (never PN'd, or an orphaned/renamed file) is simply
    dropped - this is the one place "no CAD-derived PN, no BOM entry" is
    enforced, per how kit BOMs are meant to work: only genuinely PN'd
    sub-parts show up.

    Kept independent of any FreeCAD API - the caller (methods.py) does all
    document/assembly traversal and hands this pure filename+qty data,
    since partnumbers.py otherwise never touches FreeCAD documents."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = _read_registry(cfg)

    resolved = []
    for entry in filenames:
        filename = entry.get("filename") or ""
        qty = int(entry.get("qty") or 1)
        if not filename.lower().endswith(".fcstd"):
            continue
        pn = filename[:-len(".fcstd")] if filename.lower().endswith(".fcstd") else filename
        row = _row_for_pn(rows, pn)
        if row is None:
            continue
        resolved.append({
            "pn": row["pn"], "componentName": row.get("description", ""),
            "qty": qty,
        })
    return {"items": resolved}


@method("pn.saveBom")
def pn_save_bom(pn, items):
    """Replace bom.csv's rows for this exact assembly pn with the given
    kit-item list (each {pn, componentName, qty} - the shape
    pn.resolveBomFilenames already returns). Called by the caller right
    after re-deriving the BOM live from the open assembly (see
    assembly.bomPns) - on every revision bump and every lifecycle change,
    so bom.csv never drifts from what the CAD document actually contains.
    An assembly with an empty items list still gets a (now-empty) entry
    removed rather than left stale - "no items" and "never captured" both
    end up as "no rows for this pn", which is what pn.bomFor below treats
    as "no BOM"."""
    cfg = _load_config()
    repo = _registry_path(cfg)

    def attempt():
        rows = [r for r in _read_bom(cfg) if r.get("pn") != pn]
        for item in items:
            rows.append({
                "pn": pn, "item_pn": item.get("pn", ""),
                "item_component_name": item.get("componentName", ""),
                "qty": str(int(item.get("qty") or 1)),
            })
        _write_bom(cfg, rows)
        return True

    _sync_pull(repo)
    attempt()
    _commit_and_push(repo, "%s: BOM updated (%d items)" % (pn, len(items)), attempt)
    return {"pn": pn, "itemCount": len(items)}


@method("pn.bomFor")
def pn_bom_for(pn):
    """The captured kit BOM for an exact assembly pn (not pn_seq - a BOM
    snapshot is tied to the specific revision it was captured from, same as
    everything else pn.resolveBomFilenames reports). Empty list if this pn
    has no assembly (never had App::Link children) or was never saved -
    both cases mean "no defined BOM" to callers, same as the portal side
    treats them."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = [r for r in _read_bom(cfg) if r.get("pn") == pn]
    return {"items": [
        {"pn": r.get("item_pn", ""), "componentName": r.get("item_component_name", ""),
         "qty": int(r.get("qty") or 1)}
        for r in rows
    ]}


@method("pn.getInventory")
def pn_get_inventory(pn):
    """Current derived stock/cost for an exact pn - {qtyOnHand, avgCost}.
    A pn with no purchase batches at all (or fully depleted) returns
    qtyOnHand 0, avgCost 0 - "never purchased" and "purchased then fully
    used up" look the same here on purpose; the log is where you'd go to
    tell those apart."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    batches = [b for b in _read_inventory_batches(cfg) if b.get("pn") == pn]
    return _inventory_summary(batches)


@method("pn.listInventory")
def pn_list_inventory():
    """Derived {pn, qtyOnHand, avgCost} for every pn that has ever had a
    purchase batch recorded (including ones now fully depleted, so a part
    that's run out still shows up at qtyOnHand 0 rather than disappearing)."""
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    batches = _read_inventory_batches(cfg)
    by_pn = {}
    for b in batches:
        by_pn.setdefault(b.get("pn"), []).append(b)
    return {"items": [
        {"pn": pn, **_inventory_summary(pn_batches)}
        for pn, pn_batches in by_pn.items()
    ]}


@method("pn.recordPurchase")
def pn_record_purchase(pn, qty, unitCost, source=None, purchaseDate=None):
    """Add a new purchase batch for an exact pn - the ONLY way stock or the
    weighted average cost increases. qty/unitCost are exactly what's on the
    invoice/receipt; source is a free-text note (e.g. "CSV upload:
    digikey_order.csv" or "MMC PDF: order 12345") for the audit trail.
    Returns the new derived {qtyOnHand, avgCost} for this pn after the
    purchase."""
    import uuid
    qty = int(qty)
    unit_cost = float(unitCost)
    if qty <= 0:
        raise RpcError(APP_ERROR, "purchase qty must be positive")
    cfg = _load_config()
    repo = _registry_path(cfg)
    date = purchaseDate or _now_iso()
    batch_id = uuid.uuid4().hex[:12]

    def attempt():
        rows = _read_inventory_batches(cfg)
        rows.append({
            "id": batch_id, "pn": pn, "qty_purchased": str(qty),
            "qty_remaining": str(qty), "unit_cost": str(unit_cost),
            "purchase_date": date, "source": source or "",
        })
        _write_inventory_batches(cfg, rows)
        _append_inventory_log(cfg, [{
            "date": _now_iso(), "pn": pn, "delta_qty": str(qty),
            "unit_cost": str(unit_cost), "reason": "purchase: %s" % (source or "manual"),
            "batch_id": batch_id,
        }])
        return True

    _sync_pull(repo)
    attempt()
    _commit_and_push(repo, "%s: +%d purchased @ %.4f (%s)" % (pn, qty, unit_cost, source or "manual"), attempt)

    batches = [r for r in _read_inventory_batches(cfg) if r.get("pn") == pn]
    return {"pn": pn, **_inventory_summary(batches)}


@method("pn.adjustInventory")
def pn_adjust_inventory(pn, deltaQty, reason):
    """Manual +/- adjustment that does NOT touch cost (found stock, scrap,
    a physical count correction - not a purchase, so there's no unit cost
    to record). Positive deltaQty adds a new zero-cost batch (so found
    stock doesn't silently drag the average cost toward $0 - see below);
    negative deltaQty depletes existing batches FIFO, same as consumption.

    A positive adjustment's zero cost DOES pull the weighted average down
    - there's no honest alternative (we don't know what a "found" part is
    actually worth), so this is deliberately visible in the derived
    avgCost rather than hidden. Prefer pn.recordPurchase whenever a real
    cost is known, even a corrected/estimated one."""
    if not reason or not reason.strip():
        raise RpcError(APP_ERROR, "a reason is required for a manual adjustment")
    delta_qty = int(deltaQty)
    if delta_qty == 0:
        raise RpcError(APP_ERROR, "deltaQty must be nonzero")
    cfg = _load_config()
    repo = _registry_path(cfg)

    def attempt():
        rows = _read_inventory_batches(cfg)
        if delta_qty > 0:
            import uuid
            rows.append({
                "id": uuid.uuid4().hex[:12], "pn": pn, "qty_purchased": str(delta_qty),
                "qty_remaining": str(delta_qty), "unit_cost": "0",
                "purchase_date": _now_iso(), "source": "adjustment: %s" % reason.strip(),
            })
            log_entries = [{
                "date": _now_iso(), "pn": pn, "delta_qty": str(delta_qty),
                "unit_cost": "0", "reason": "adjustment: %s" % reason.strip(), "batch_id": "",
            }]
        else:
            deducted, log_entries = _deplete_fifo(rows, pn, -delta_qty)
            for entry in log_entries:
                entry["reason"] = "adjustment: %s" % reason.strip()
            if deducted < -delta_qty:
                raise RpcError(APP_ERROR,
                                "cannot remove %d units of %s - only %d on hand" %
                                (-delta_qty, pn, deducted))
        _write_inventory_batches(cfg, rows)
        _append_inventory_log(cfg, log_entries)
        return True

    _sync_pull(repo)
    attempt()
    _commit_and_push(repo, "%s: inventory adjustment %+d (%s)" % (pn, delta_qty, reason.strip()), attempt)

    batches = [r for r in _read_inventory_batches(cfg) if r.get("pn") == pn]
    return {"pn": pn, **_inventory_summary(batches)}


@method("pn.consumeAssembly")
def pn_consume_assembly(pn, qty, reason=None):
    """Consume qty of pn, walking its BOM to cover any shortfall: first
    deplete pn's OWN stock (a pre-built assembly sitting on a shelf is used
    as-is, no effect on its sub-parts); for whatever remainder isn't
    covered by pn's own stock, recurse into pn.bomFor(pn) and apply the
    SAME rule to each sub-part (its own stock absorbs first, cascading
    further down only for its own shortfall). Bottoms out at leaf parts
    (no BOM of their own), which have no stock of their own "assembly" to
    check - only their raw stock is depleted, going negative-tolerant (see
    _deplete_fifo) if none is on hand rather than blocking the whole
    operation on a single missing screw.

    This is the ONLY consumption path that understands assemblies - use
    pn.adjustInventory directly for a raw part with no BOM."""
    qty = int(qty)
    if qty <= 0:
        raise RpcError(APP_ERROR, "consume qty must be positive")
    cfg = _load_config()
    repo = _registry_path(cfg)
    reason_note = "consumed (assembly)%s" % (": %s" % reason.strip() if reason else "")

    def deplete_recursive(rows, target_pn, target_qty, all_log_entries, visited):
        # visited guards against a malformed/circular BOM (should never
        # happen from real CAD data, but a corrupted bom.csv row shouldn't
        # be able to infinite-loop this) rather than assuming good data.
        if target_pn in visited or target_qty <= 0:
            return
        visited = visited | {target_pn}
        deducted, log_entries = _deplete_fifo(rows, target_pn, target_qty)
        all_log_entries.extend(log_entries)
        shortfall = target_qty - deducted
        if shortfall <= 0:
            return
        bom_rows = [r for r in _read_bom(cfg) if r.get("pn") == target_pn]
        for item in bom_rows:
            item_pn = item.get("item_pn")
            item_qty = int(item.get("qty") or 1)
            if item_pn:
                deplete_recursive(rows, item_pn, shortfall * item_qty, all_log_entries, visited)

    def attempt():
        rows = _read_inventory_batches(cfg)
        all_log_entries = []
        deplete_recursive(rows, pn, qty, all_log_entries, frozenset())
        for entry in all_log_entries:
            entry["reason"] = reason_note
        _write_inventory_batches(cfg, rows)
        _append_inventory_log(cfg, all_log_entries)
        return True

    _sync_pull(repo)
    attempt()
    _commit_and_push(repo, "%s: consumed %d (assembly walk)" % (pn, qty), attempt)
    return {"pn": pn, "qty": qty}


@method("pn.tagDocument")
def pn_tag_document(pn, name, description):
    """Attach a PN/Name/Description to the CURRENTLY OPEN document's session
    state. Pure bookkeeping - does not touch the registry or disk; the caller
    still does its own saveAs/newRevision. document.saveAs/save mirror this
    onto real FreeCAD document properties automatically once tagged."""
    from . import session as _session
    _session.set_part_number({"pn": pn, "name": name, "description": description})
    return {"ok": True}


@method("pn.repoForPath")
def pn_repo_for_path(path):
    """Which configured project repo (if any) a filesystem path falls under
    - used by the New Design flow to decide whether saving there requires a
    PN. Returns {"project": None} for anything outside every configured repo
    (untracked scratch work stays untracked)."""
    cfg = _load_config()
    path = os.path.abspath(os.path.expanduser(path))
    candidates = list((cfg.get("projects") or {}).items())
    best = None
    for code, entry in candidates:
        repo = entry.get("repoPath")
        if not repo:
            continue
        repo_abs = os.path.abspath(repo)
        if path == repo_abs or path.startswith(repo_abs + os.sep):
            if best is None or len(repo_abs) > len(best[1]):
                best = (code, repo_abs)
    if best is None:
        return {"project": None}
    return {"project": best[0], "repoPath": best[1]}


@method("pn.checkLocation")
def pn_check_location(pnSeq, openedPath):
    """A document tagged with pnSeq was just opened from openedPath - does
    that match pn.resolve's answer for it? Since pn.resolve itself falls back
    to a recursive filename search, this only fires for a genuine anomaly:
    e.g. a stray duplicate copy of <pn>.FCStd sitting somewhere else in the
    repo (or a different repo) that the user opened directly by mistake
    instead of through pn.resolve/the PN browser. Never auto-corrects
    anything; the caller decides what to do."""
    cfg = _load_config()
    if not cfg.get("registryPath"):
        return {"matches": True}
    try:
        expected = pn_resolve(pnSeq)["path"]
    except RpcError:
        return {"matches": True}
    opened_abs = os.path.abspath(os.path.expanduser(openedPath))
    return {"matches": os.path.normpath(expected) == os.path.normpath(opened_abs),
            "expectedPath": expected, "openedPath": opened_abs}


@method("pn.relocate")
def pn_relocate(pnSeq, newPath):
    """Refresh the registry's cached location hint for pnSeq's current rev to
    newPath, where the user just confirmed that's the file's real location
    (e.g. after pn.checkLocation flagged a mismatch). Fails if newPath isn't
    inside the PN's own project repo (that's a project change, a human
    decision) or doesn't have the right filename for this PN/rev (that's a
    different part, not a move)."""
    cfg = _load_config()
    reg_repo = _registry_path(cfg)

    def attempt():
        rows = _read_registry(cfg)
        cur = _current_row(rows, pnSeq)
        if cur is None:
            raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pnSeq)
        proj_repo = os.path.abspath(_repo_path_for(cfg, cur["project"]))
        new_abs = os.path.abspath(os.path.expanduser(newPath))
        if not (new_abs == proj_repo or new_abs.startswith(proj_repo + os.sep)):
            raise RpcError(APP_ERROR,
                            "%s is outside %s's repo (%s) - this looks like a "
                            "project change, not a simple move" % (newPath, cur["project"], proj_repo))
        expected_name = _filename_for(cur["project"], cur["type"], int(cur["seq"]), int(cur["rev"]))
        if os.path.basename(new_abs) != expected_name:
            raise RpcError(APP_ERROR,
                            "%s doesn't look like %s's current rev file - "
                            "expected a file named %s" % (newPath, pnSeq, expected_name))
        relpath = os.path.relpath(new_abs, proj_repo)
        if cur.get("repo_relpath") == relpath:
            return False
        cur["repo_relpath"] = relpath
        _write_registry(cfg, rows)
        return True

    _sync_pull(reg_repo)
    if not attempt():
        return {"ok": True, "unchanged": True}
    _commit_and_push(reg_repo, "Update location hint for %s" % pnSeq, attempt)
    return {"ok": True}


@method("pn.resolve")
def pn_resolve(pnSeqOrFull):
    """Absolute path to a PN's current-rev file. Accepts either the bare
    sequence id (PSA008) or a full PN with rev digit (PSA0080) - the rev
    digit is ignored, this always resolves to whatever the current rev is.
    The file may live anywhere in its project repo (organized into whatever
    subfolders the project uses) - this checks the registry's cached hint
    first, then falls back to a recursive filename search if the hint is
    stale, and self-heals the hint when the search finds it somewhere else."""
    pn_seq = pnSeqOrFull[:-1] if pnSeqOrFull[-1:].isdigit() and len(pnSeqOrFull) > 6 else pnSeqOrFull
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = _read_registry(cfg)
    cur = _current_row(rows, pn_seq)
    if cur is None:
        raise RpcError(APP_ERROR, "unknown PN: %s" % pnSeqOrFull)
    repo = _repo_path_for(cfg, cur["project"])
    filename = _filename_for(cur["project"], cur["type"], int(cur["seq"]), int(cur["rev"]))
    abspath, relpath = _find_part_file(repo, filename, cur.get("repo_relpath"))
    if abspath is None:
        raise RpcError(APP_ERROR,
                        "%s not found anywhere under %s" % (filename, repo))
    if relpath != cur.get("repo_relpath"):
        # The hint was stale (file got moved by hand) - heal it so the next
        # lookup takes the fast path instead of re-searching.
        def attempt():
            rows2 = _read_registry(cfg)
            cur2 = _current_row(rows2, pn_seq)
            if cur2 is None or cur2.get("repo_relpath") == relpath:
                return False
            cur2["repo_relpath"] = relpath
            _write_registry(cfg, rows2)
            return True
        try:
            reg_repo = _registry_path(cfg)
            if attempt():
                _commit_and_push(reg_repo, "Update location hint for %s" % pn_seq, attempt)
        except RpcError:
            pass  # healing the hint is best-effort - resolving the path still succeeds
    return {"path": abspath, "row": cur}
