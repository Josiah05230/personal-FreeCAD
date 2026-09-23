"""Auto-export STEP + PDF to Firebase Storage when a part is promoted to
`active` (see App.tsx's setLifecycle, which calls export.promote right
after pn.setLifecycle succeeds - this module never touches the lifecycle
write itself, partnumbers.py already owns that).

Runs synchronously inline in the RPC call - no job queue. Promotion only
ever happens from a desktop session with FreeCAD already open (the same
assumption pn_set_lifecycle's own docs make), so there's no case where
this needs to run detached from a live document.

A failed export must never look like a failed promotion: every error path
here is reported back as data in the result dict, not raised, except for
the couple of "can't even get started" cases (unknown PN, no source file)
where there's nothing useful to partially do.
"""
import datetime
import json
import os
import tempfile

from .registry import method, RpcError, APP_ERROR
from . import session
from . import partnumbers as _pn
from . import drawing as _drawing
from . import firebase_storage as _storage


def _git(repo, *args):
    # same shape as partnumbers._git, duplicated rather than imported since
    # that name is module-private there and this only needs one read-only
    # call (rev-parse) - not worth widening partnumbers' own surface for.
    import subprocess
    r = subprocess.run(["git", "-C", repo] + list(args),
                        capture_output=True, text=True)
    if r.returncode != 0:
        raise RpcError(APP_ERROR, "git %s failed in %s: %s" % (" ".join(args), repo, r.stderr.strip()))
    return r.stdout.strip()


def _resolve_part(pn_seq):
    """(row, repo_path, abs_path) for a PN sequence's current revision, via
    the exact same lookup chain pn_set_lifecycle already resolves through
    conceptually - _current_row/_repo_path_for/_find_part_file are already
    plain functions in partnumbers.py, just not previously exposed as a
    standalone lookup."""
    cfg = _pn._load_config()
    rows = _pn._read_registry(cfg)
    row = _pn._current_row(rows, pn_seq)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pn_seq)
    repo = _pn._repo_path_for(cfg, row["project"])
    _pn._sync_pull(repo)
    filename = _pn._filename_for(row["project"], row["type"], int(row["seq"]), int(row["rev"]))
    abspath, _relpath = _pn._find_part_file(repo, filename, row.get("repo_relpath"))
    if abspath is None:
        raise RpcError(APP_ERROR, "%s: no %s found in %s" % (row["pn"], filename, repo))
    return row, repo, abspath


def _first_drawing_page(doc):
    for o in doc.Objects:
        if o.TypeId == "TechDraw::DrawPage":
            return o.Name
    return None


@method("export.promote")
def export_promote(pnSeq):
    """Export the currently-open document's STEP + (if it has a drawing
    page) PDF, tag them with the pn-cad-files commit they came from, and
    push all three to Firebase Storage at cad-exports/<PN>/. Called right
    after a successful pn.setLifecycle(..., 'active') - the lifecycle
    write has already landed by the time this runs, so nothing here can
    undo it; every failure is reported back as data, not raised, once the
    part itself is confirmed to exist and be open."""
    row, repo, _abspath = _resolve_part(pnSeq)
    pn = row["pn"]

    d = session.doc(create=False)
    if d is None:
        return {"pn": pn, "ok": False, "error": "no document is open"}

    result = {"pn": pn, "ok": True, "stepUploaded": False, "pdfGenerated": False,
              "pdfUploaded": False, "pdfSkippedReason": None, "errors": []}

    try:
        fcstd_commit = _git(repo, "rev-parse", "HEAD")
    except RpcError as e:
        fcstd_commit = None
        result["errors"].append("git commit lookup failed: %s" % e.message)

    tmpdir = tempfile.mkdtemp(prefix="gwtcad-export-")
    try:
        # --- STEP ---
        step_path = os.path.join(tmpdir, "%s.step" % pn)
        try:
            from . import methods as _methods
            _methods.io_export_step(step_path)
        except Exception as e:
            result["ok"] = False
            result["errors"].append("STEP export failed: %s" % e)
            step_path = None

        if step_path and os.path.isfile(step_path):
            try:
                _storage.upload_file(
                    step_path, "cad-exports/%s/%s.step" % (pn, pn),
                    "application/STEP"
                )
                result["stepUploaded"] = True
            except RpcError as e:
                result["ok"] = False
                result["errors"].append("STEP upload failed: %s" % e.message)

        # --- PDF (best-effort: no drawing page is a skip, not a failure) ---
        page_id = _first_drawing_page(d)
        if page_id is None:
            result["pdfSkippedReason"] = "no drawing page"
        else:
            pdf_path = None
            try:
                svg = _drawing.export_page_svg(d, page_id)
                svg_path = os.path.join(tmpdir, "%s.svg" % pn)
                with open(svg_path, "w", encoding="utf-8") as f:
                    f.write(svg)
                pdf_path = os.path.join(tmpdir, "%s.pdf" % pn)
                import subprocess
                r = subprocess.run(
                    ["rsvg-convert", "-f", "pdf", "-o", pdf_path, svg_path],
                    capture_output=True, text=True, timeout=60
                )
                if r.returncode != 0 or not os.path.isfile(pdf_path):
                    raise RuntimeError("rsvg-convert failed: %s" % (r.stderr or r.stdout))
                result["pdfGenerated"] = True
            except Exception as e:
                result["errors"].append("PDF export failed: %s" % e)
                pdf_path = None

            if pdf_path and os.path.isfile(pdf_path):
                try:
                    _storage.upload_file(
                        pdf_path, "cad-exports/%s/%s.pdf" % (pn, pn),
                        "application/pdf"
                    )
                    result["pdfUploaded"] = True
                except RpcError as e:
                    result["errors"].append("PDF upload failed: %s" % e.message)

        # --- metadata (uploaded regardless, so the portal can always see
        # what the last export attempt actually did, even a partial one) ---
        meta = {
            "fcstdCommit": fcstd_commit,
            "exportedAt": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "pdfGenerated": result["pdfGenerated"],
        }
        try:
            _storage.upload_bytes(
                "cad-exports/%s/meta.json" % pn,
                json.dumps(meta, indent=2).encode("utf-8"),
                "application/json"
            )
        except RpcError as e:
            result["errors"].append("metadata upload failed: %s" % e.message)
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    if result["errors"] and not (result["stepUploaded"] or result["pdfUploaded"]):
        result["ok"] = False
    return result
