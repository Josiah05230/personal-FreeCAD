"""pn.copyIn: bring a file from OUTSIDE the company repos into one, as a
brand-new part, before it gets used by a company document.

The UI calls this after the normal New Part dialog has reserved the PN
(pn.reserve) and handed back the absolute path the part's .FCStd belongs
at. That path decides the folder - this module never computes a repo
layout itself, so it follows whatever partnumbers._new_part_relpath says
today (nested <pn>/ folder or flat).

What lands next to the reserved .FCStd:
  - an outside .FCStd  -> copied AS the part file, then PN-tagged
  - STEP/IGES/BREP/mesh -> <pn>.<ext> (the original, untouched) plus a
                           <pn>.FCStd holding that geometry, so the PN opens,
                           links into assemblies and resolves like any part
  - a KiCad board/project -> the project's files (same selection and
                           placement as File > New Part from File), plus a
                           PN-tagged <pn>.FCStd
  - anything else (image, pdf, dxf, ...) -> <pn>.<ext> plus a PN-tagged
                           <pn>.FCStd (e.g. a label: the artwork is the
                           part's content, the FCStd keeps pn.resolve and the
                           PN browser working)
Then only those files are committed (never a blanket `git add -A` over
whatever else is dirty in the repo) and pushed best-effort - an offline
copy-in still succeeds locally, the next save's push carries it.

FreeCAD is imported lazily inside the functions that need it, so the
path/copy logic is importable under plain pytest.
"""
import os
import shutil

from .registry import method, RpcError, APP_ERROR
from . import partnumbers as _pn
from . import import_dispatch as _dispatch

_BREP_EXTS = (".step", ".stp", ".iges", ".igs", ".brep", ".brp")
_MESH_EXTS = (".stl", ".obj", ".3mf", ".ply", ".off")
_KICAD_EXTS = (".kicad_pcb", ".kicad_pro", ".kicad_sch")


def _under(path, root):
    path = os.path.realpath(path)
    root = os.path.realpath(root)
    return path == root or path.startswith(root + os.sep)


def company_roots(cfg):
    """Every configured company location: each project's repoPath, the
    shared ECAD repo, the PN registry."""
    roots = [(p or {}).get("repoPath") for p in (cfg.get("projects") or {}).values()]
    roots += [cfg.get("ecadRepoPath"), cfg.get("registryPath")]
    return [os.path.abspath(os.path.expanduser(r)) for r in roots if r]


def in_company_repo(path, cfg):
    return any(_under(path, r) for r in company_roots(cfg))


def _copy_plain(pn, source, dest_dir):
    """<pn>.<original ext> next to the part file - never overwrites."""
    ext = os.path.splitext(source)[1]
    dest = os.path.join(dest_dir, pn + ext)
    if os.path.exists(dest):
        raise RpcError(APP_ERROR, "%s already exists - not overwriting it" % dest)
    shutil.copy2(source, dest)
    return {"copiedPath": dest, "files": [dest]}


def _copy_kicad(source, dest_dir):
    """Same selection + placement New Part from File uses for the ECAD half:
    the board's whole project folder (schematic, project file, footprint
    models, attachments), laid out relative to the board."""
    staged = _dispatch.inspect(source)
    try:
        relpaths = [f["relpath"] for f in staged["files"] if f["role"] != "mechanical"]
        placed = _dispatch.place_ecad(staged["extractDir"], relpaths, dest_dir)
    finally:
        _dispatch.cleanup(staged["extractDir"])
    main = placed.get("pcbPath") or placed.get("proPath") or placed.get("schPath")
    return {"copiedPath": main, "files": placed["placed"], "pcbPath": placed.get("pcbPath"),
            "proPath": placed.get("proPath"), "schPath": placed.get("schPath")}


def _tag(d, pn, name, description):
    from .methods import _apply_part_number_props
    _apply_part_number_props(d, {"pn": pn, "name": name, "description": description})


def _write_part_file(fcstd, pn, name, description, model=None, existing=False):
    """Build (or, existing=True, re-tag) the part's .FCStd in a scratch
    FreeCAD document - never the session's live one - and put the active
    document back afterwards."""
    import FreeCAD as App
    prev = App.ActiveDocument.Name if App.ActiveDocument else None
    d = App.openDocument(fcstd) if existing else App.newDocument("gwtcad_copyin")
    try:
        if model:
            ext = os.path.splitext(model)[1].lower()
            if ext in _BREP_EXTS:
                import Import
                Import.insert(model, d.Name)
            else:
                import Mesh
                Mesh.insert(model, d.Name)
            d.recompute()
            new = list(d.Objects)
            stem = os.path.splitext(os.path.basename(model))[0]
            for i, o in enumerate(new):
                try:
                    o.Label = stem if len(new) == 1 else "%s %d" % (stem, i + 1)
                except Exception:
                    pass
        _tag(d, pn, name, description)
        if existing:
            d.save()
        else:
            d.saveAs(fcstd)
    finally:
        App.closeDocument(d.Name)
        if prev and prev in App.listDocuments():
            App.setActiveDocument(prev)


def _commit(paths, message):
    """Commit exactly `paths` (other staged/dirty work in the repo is left
    alone) and push best-effort. Returns {committed, pushed}."""
    if not paths:
        return {"committed": False, "pushed": False}
    cwd = os.path.dirname(paths[0])
    ok, _ = _pn._git_ok(cwd, "rev-parse", "--git-dir")
    if not ok:
        return {"committed": False, "pushed": False}
    _pn._git(cwd, "add", "--", *paths)
    clean, _ = _pn._git_ok(cwd, "diff", "--cached", "--quiet", "--", *paths)
    if clean:  # --quiet exits 0 when nothing is staged
        return {"committed": False, "pushed": False}
    _pn._git(cwd, "commit", "-m", message, "--", *paths)
    if not _pn._has_remote(cwd):
        return {"committed": True, "pushed": False}
    for _attempt in range(3):
        ok, _ = _pn._git_ok(cwd, "push")
        if ok:
            return {"committed": True, "pushed": True}
        ok, _ = _pn._git_ok(cwd, "pull", "--rebase", "--autostash")
        if not ok:
            break
    return {"committed": True, "pushed": False}


@method("pn.copyIn")
def pn_copy_in(pn, name, description, fcstdPath, sourcePath):
    """Copy `sourcePath` (outside every company repo) in as part `pn`,
    whose reserved file path is `fcstdPath`. Returns:
      fcstdPath  - the part's .FCStd (link THIS into an assembly)
      copiedPath - the in-repo copy of the source itself (import/insert
                   from THIS, never the outside path); == fcstdPath for an
                   .FCStd source, the .kicad_pcb for a KiCad project
      pcbPath/proPath/schPath - KiCad sources only
      files, committed, pushed"""
    cfg = _pn._load_config()
    fcstd = os.path.abspath(os.path.expanduser(fcstdPath or ""))
    source = os.path.abspath(os.path.expanduser(sourcePath or ""))
    if not os.path.isfile(source):
        raise RpcError(APP_ERROR, "file not found: %s" % source)
    if not in_company_repo(fcstd, cfg):
        raise RpcError(APP_ERROR, "%s is not inside a company repo" % fcstd)
    if os.path.exists(fcstd):
        raise RpcError(APP_ERROR, "%s already exists - not overwriting it" % fcstd)
    dest_dir = os.path.dirname(fcstd)
    os.makedirs(dest_dir, exist_ok=True)
    # best-effort: start from the team's latest so the push below is a
    # fast-forward (offline is fine - the commit stays local until next push)
    if _pn._has_remote(dest_dir):
        _pn._git_ok(dest_dir, "pull", "--rebase", "--autostash")

    low = source.lower()
    out = {"pcbPath": None, "proPath": None, "schPath": None}
    if low.endswith(".fcstd"):
        shutil.copy2(source, fcstd)
        _write_part_file(fcstd, pn, name, description, existing=True)
        out.update({"copiedPath": fcstd, "files": [fcstd]})
    else:
        if low.endswith(_KICAD_EXTS):
            out.update(_copy_kicad(source, dest_dir))
            model = None
        else:
            out.update(_copy_plain(pn, source, dest_dir))
            model = out["copiedPath"] if low.endswith(_BREP_EXTS + _MESH_EXTS) else None
        _write_part_file(fcstd, pn, name, description, model=model)
        out["files"] = out["files"] + [fcstd]
    out["fcstdPath"] = fcstd
    out.update(_commit(out["files"], "Add %s (%s): copied in from %s" % (pn, description, os.path.basename(source))))
    return out
