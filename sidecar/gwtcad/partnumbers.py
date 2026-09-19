"""Company part-number (PN) manager: assigns/looks up/revises GWT part
numbers against a shared, git-backed registry, and locates the on-disk CAD
files that carry them across a company's per-project git repos.

Layout this module assumes (all paths come from ~/.gwtcad/company.json, none
are hardcoded):
  - one shared "registry" repo holding registry.csv (one row per PN sequence,
    not per revision) and types.yaml (project-defined type-letter map);
  - one git repo per project (keyed by a 2-letter project code) plus one
    "hardware" repo, each holding the actual .FCStd files;
  - a PN is "[project][type][seq3][rev1]", e.g. PSA0080. seq is fixed for the
    part's life; a revision bump copies the current file to the next rev
    number and updates the registry's current_rev - the old rev file is left
    alone on disk and in git history.

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

_REGISTRY_FIELDS = [
    "pn_seq", "project", "type", "seq", "current_rev", "name", "description",
    "repo_relpath", "status", "created", "modified",
]

_MAX_PUSH_RETRIES = 5


# --------------------------------------------------------------------------- #
# company.json
# --------------------------------------------------------------------------- #

def _load_config():
    if not os.path.exists(_CONFIG_PATH):
        return {"registryPath": None, "projects": {}, "hardware": None}
    try:
        import json
        with open(_CONFIG_PATH) as f:
            cfg = json.load(f)
    except Exception:
        return {"registryPath": None, "projects": {}, "hardware": None}
    cfg.setdefault("registryPath", None)
    cfg.setdefault("projects", {})
    cfg.setdefault("hardware", None)
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
def pn_set_company_config(registryPath=None, projects=None, hardware=None):
    cfg = _load_config()
    if registryPath is not None:
        cfg["registryPath"] = registryPath
    if projects is not None:
        cfg["projects"] = projects
    if hardware is not None:
        cfg["hardware"] = hardware
    _save_config(cfg)
    return cfg


def _repo_path_for(cfg, project):
    """Resolve a 2-letter project code (or the literal "hardware") to its
    repo path, raising a clear app error if company.json isn't set up for it
    yet rather than a bare KeyError."""
    if project == "hardware":
        entry = cfg.get("hardware")
        path = entry.get("repoPath") if entry else None
    else:
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
# registry.csv
# --------------------------------------------------------------------------- #

def _registry_csv(cfg):
    return os.path.join(_registry_path(cfg), "registry.csv")


def _read_registry(cfg):
    path = _registry_csv(cfg)
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def _write_registry(cfg, rows):
    path = _registry_csv(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_REGISTRY_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in _REGISTRY_FIELDS})
    os.replace(tmp, path)


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


@method("pn.listAll")
def pn_list_all(project=None, status=None):
    cfg = _load_config()
    if not cfg.get("registryPath"):
        return {"parts": []}
    _sync_pull(_registry_path(cfg))
    rows = _read_registry(cfg)
    if project:
        rows = [r for r in rows if r.get("project") == project]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return {"parts": rows}


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


@method("pn.reserve")
def pn_reserve(project, type, seq, name, description):
    """Assign a brand-new PN at rev 0 and append it to the registry. Returns
    the assigned PN string and the relative path the caller should save the
    new .FCStd at (caller still does the actual FreeCAD saveAs - this RPC
    only reserves the identity)."""
    cfg = _load_config()
    seq = int(seq)
    repo = _registry_path(cfg)
    pn_seq = "%s%s%03d" % (project, type, seq)
    relpath = "%s.FCStd" % _fmt_pn(project, type, seq, 0)

    def attempt():
        rows = _read_registry(cfg)
        if any(r.get("pn_seq") == pn_seq for r in rows):
            # Someone else already took this exact seq - caller must retry
            # with a fresh pn.listAvailableSeq; nothing for us to commit.
            return False
        rows.append({
            "pn_seq": pn_seq, "project": project, "type": type,
            "seq": "%03d" % seq, "current_rev": "0", "name": name,
            "description": description, "repo_relpath": relpath,
            "status": "active", "created": _now_iso(), "modified": _now_iso(),
        })
        _write_registry(cfg, rows)
        return True

    _sync_pull(repo)
    if not attempt():
        raise RpcError(APP_ERROR,
                        "PN %s was just taken by someone else - pick another "
                        "sequence number" % pn_seq)
    _commit_and_push(repo, "Reserve PN %s0 (%s)" % (pn_seq, name), attempt)

    return {"pn": _fmt_pn(project, type, seq, 0), "pnSeq": pn_seq, "rev": 0,
            "repoRelpath": relpath, "name": name, "description": description}


@method("pn.newRevision")
def pn_new_revision(pnSeq):
    """Copy the current-rev file to the next rev number in its project repo
    and advance current_rev in the registry. The OLD rev file is left in
    place on disk and in git history - this never overwrites or deletes it."""
    cfg = _load_config()
    reg_repo = _registry_path(cfg)
    _sync_pull(reg_repo)
    rows = _read_registry(cfg)
    row = next((r for r in rows if r.get("pn_seq") == pnSeq), None)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pnSeq)

    project, type, seq = row["project"], row["type"], int(row["seq"])
    old_rev = int(row["current_rev"])
    new_rev = old_rev + 1
    proj_repo = _repo_path_for(cfg, project)

    old_relpath = row["repo_relpath"]
    new_relpath = "%s.FCStd" % _fmt_pn(project, type, seq, new_rev)
    old_abspath = os.path.join(proj_repo, old_relpath)
    new_abspath = os.path.join(proj_repo, new_relpath)
    if not os.path.isfile(old_abspath):
        raise RpcError(APP_ERROR, "current rev file missing on disk: %s" % old_abspath)
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
        row2 = next((r for r in rows2 if r.get("pn_seq") == pnSeq), None)
        if row2 is None or int(row2["current_rev"]) != old_rev:
            # Someone else already bumped this PN's revision since we
            # started - our copied file is now stale/wrong, surface that.
            raise RpcError(APP_ERROR,
                            "PN %s's revision changed underneath us - retry" % pnSeq)
        row2["current_rev"] = str(new_rev)
        row2["repo_relpath"] = new_relpath
        row2["modified"] = _now_iso()
        _write_registry(cfg, rows2)
        return True

    _sync_pull(reg_repo)
    attempt()
    _commit_and_push(reg_repo, "Advance %s to rev %d" % (pnSeq, new_rev), attempt)

    return {"pn": _fmt_pn(project, type, seq, new_rev), "pnSeq": pnSeq,
            "rev": new_rev, "repoRelpath": new_relpath,
            "path": new_abspath, "name": row["name"], "description": row["description"]}


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
    """Which configured project/hardware repo (if any) a filesystem path
    falls under - used by the New Design flow to decide whether saving there
    requires a PN. Returns {"project": None} for anything outside every
    configured repo (untracked scratch work stays untracked)."""
    cfg = _load_config()
    path = os.path.abspath(os.path.expanduser(path))
    candidates = list((cfg.get("projects") or {}).items())
    hw = cfg.get("hardware")
    if hw and hw.get("repoPath"):
        candidates.append(("hardware", hw))
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
    that match where the registry thinks its current rev lives? Mismatches
    happen whenever a file is moved/renamed outside GWT-CAD (Finder, a plain
    `mv`, a manual git operation) rather than through pn.newRevision. This
    never auto-corrects anything; the caller decides whether to offer
    updating the registry to match reality."""
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
    """Update the registry's repo_relpath for pnSeq's CURRENT rev to match a
    file that was moved/renamed outside GWT-CAD, without touching the file
    itself (it's already at newPath). Fails if newPath isn't inside the PN's
    own project repo - that would mean the part actually changed projects,
    which needs a human decision, not an automatic registry patch."""
    cfg = _load_config()
    reg_repo = _registry_path(cfg)

    def attempt():
        rows = _read_registry(cfg)
        row = next((r for r in rows if r.get("pn_seq") == pnSeq), None)
        if row is None:
            raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pnSeq)
        proj_repo = os.path.abspath(_repo_path_for(cfg, row["project"]))
        new_abs = os.path.abspath(os.path.expanduser(newPath))
        if not (new_abs == proj_repo or new_abs.startswith(proj_repo + os.sep)):
            raise RpcError(APP_ERROR,
                            "%s is outside %s's repo (%s) - this looks like a "
                            "project change, not a simple move" % (newPath, row["project"], proj_repo))
        relpath = os.path.relpath(new_abs, proj_repo)
        if row["repo_relpath"] == relpath:
            return False
        row["repo_relpath"] = relpath
        row["modified"] = _now_iso()
        _write_registry(cfg, rows)
        return True

    _sync_pull(reg_repo)
    if not attempt():
        return {"ok": True, "unchanged": True}
    _commit_and_push(reg_repo, "Relocate %s to match moved file" % pnSeq, attempt)
    return {"ok": True}


@method("pn.resolve")
def pn_resolve(pnSeqOrFull):
    """Absolute path to a PN's current-rev file. Accepts either the bare
    sequence id (PSA008) or a full PN with rev digit (PSA0080) - the rev
    digit is ignored, this always resolves to whatever current_rev is."""
    pn_seq = pnSeqOrFull[:-1] if pnSeqOrFull[-1:].isdigit() and len(pnSeqOrFull) > 6 else pnSeqOrFull
    cfg = _load_config()
    _sync_pull(_registry_path(cfg))
    rows = _read_registry(cfg)
    row = next((r for r in rows if r.get("pn_seq") == pn_seq), None)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN: %s" % pnSeqOrFull)
    repo = _repo_path_for(cfg, row["project"])
    return {"path": os.path.join(repo, row["repo_relpath"]), "row": row}
