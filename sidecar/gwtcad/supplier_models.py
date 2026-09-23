"""Organizes supplier-fetched 3D models into pn-cad-files, and generates a
minimal "purchased part" reference drawing (isometric view + a GWT PN <->
supplier PN callout) for parts that have no real CAD source of their own.

Two-stage pipeline, matching the split this feature's design settled on:
  1. GrainWavePartners' Cloud Function fetches a supplier's 3D model (Aptiv's
     open HawkSearch API, currently the only supplier with one - see
     tryFetchSupplierModel in functions/index.js) at PN-reservation time and
     drops the raw ZIP in Firebase Storage at
     cad-exports/<PN>/<PN>_supplier_model.zip. That side never touches git
     or FreeCAD - it has neither.
  2. This module (GWT-CAD, which has both) does the rest: sync_supplier_models
     finds ZIPs not yet organized, unzips the .stp into pn-cad-files/<PN>/,
     and commits+pushes; generate_supplier_drawing builds the reference
     FCStd+PDF for a PN that has a .stp but no drawing yet, uploading the
     PDF to cad-exports/<PN>/<PN>.pdf (same path export.py's promote-to-active
     pipeline already uses, so the portal's admin CAD Files viewer shows it
     with zero portal-side changes).

Both are meant to run from TWO triggers (see this feature's design
conversation): automatically on GWT-CAD startup (catches anything reserved
while GWT-CAD wasn't running), and on-demand from a UI button (so a user
doesn't have to relaunch the app to get a drawing generated right when they
need one).
"""
import io
import os
import tempfile
import zipfile

import FreeCAD as App
import Part

from .registry import method, RpcError, APP_ERROR
from . import partnumbers as _pn
from . import drawing as _drawing
from . import firebase_storage as _storage


def _cad_repo_path(cfg, pn):
    # A supplier-fetched model has no meaningful "project" of its own beyond
    # whatever project code the PN itself carries (e.g. CMG0010 -> project
    # "CM") - _repo_path_for already resolves any project code to its
    # configured repoPath, so this is just that same lookup keyed off the PN
    # string rather than a row already in hand.
    project = pn[:2]
    return _pn._repo_path_for(cfg, project)


def _extract_stp_from_zip(zip_bytes):
    """The ONE .stp/.step file inside a fetched ZIP (Aptiv's ZIPs contain
    exactly one), or None if the archive is empty/unexpected - a malformed
    or unexpected ZIP shape is a skip, not a crash, since a future supplier
    integration might package things differently and this should degrade
    gracefully rather than take down the whole sync pass."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith((".stp", ".step"))]
        if not names:
            return None
        return zf.read(names[0])


@method("supplierModels.sync")
def sync_supplier_models():
    """Finds every cad-exports/<PN>/<PN>_supplier_model.zip that hasn't been
    unzipped into pn-cad-files yet (checked by whether <PN>/<PN>.stp already
    exists in the repo - idempotent, safe to call on every startup), and
    commits the extracted .stp for each. Returns a per-PN result list so a
    caller can report exactly what happened rather than a single pass/fail.
    """
    cfg = _pn._load_config()
    results = []

    names = _storage.list_objects("cad-exports/")
    zip_paths = [n for n in names if n.endswith("_supplier_model.zip")]

    # Group by repo so each repo is pulled/pushed once for the whole batch,
    # not once per part - a startup scan could easily find a dozen at once.
    by_repo = {}
    for storage_path in zip_paths:
        # cad-exports/<PN>/<PN>_supplier_model.zip
        pn = storage_path.split("/")[1]
        try:
            repo = _cad_repo_path(cfg, pn)
        except RpcError as e:
            results.append({"pn": pn, "ok": False, "error": e.message})
            continue
        by_repo.setdefault(repo, []).append((pn, storage_path))

    for repo, items in by_repo.items():
        _pn._sync_pull(repo)
        changed = False
        for pn, storage_path in items:
            dest = os.path.join(repo, pn, "%s.stp" % pn)
            if os.path.isfile(dest):
                results.append({"pn": pn, "ok": True, "skipped": "already organized"})
                continue
            try:
                zip_bytes = _storage.download_bytes(storage_path)
                if zip_bytes is None:
                    results.append({"pn": pn, "ok": False, "error": "zip vanished from Storage"})
                    continue
                stp_bytes = _extract_stp_from_zip(zip_bytes)
                if stp_bytes is None:
                    results.append({"pn": pn, "ok": False, "error": "no .stp/.step found in zip"})
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(stp_bytes)
                changed = True
                results.append({"pn": pn, "ok": True, "path": dest})
            except Exception as e:
                results.append({"pn": pn, "ok": False, "error": str(e)})
        if changed:
            _pn._commit_and_push(
                repo,
                "Organize %d supplier-fetched 3D model(s)" % sum(1 for r in results if r.get("path")),
                lambda: True,
            )
    return results


@method("supplierModels.generateDrawing")
def generate_supplier_drawing(pn):
    """Build the minimal reference drawing for a purchased part that has a
    supplier-fetched .stp in pn-cad-files but no FCStd/drawing of its own
    yet - an isometric view of the imported geometry plus a callout mapping
    the GWT PN to the supplier's own part number. Idempotent: a PN that
    already has <PN>.FCStd in its repo folder is treated as done, not
    regenerated (a real design might get hand-edited after the fact -
    this never overwrites a file it didn't just create in this same call).
    Returns a result dict; never raises for an expected "nothing to do"
    outcome (no .stp yet, already has a drawing), only for real
    misconfiguration (unknown PN, no registry entry)."""
    cfg = _pn._load_config()
    rows = _pn._read_registry(cfg)
    pn_seq = pn[:-1]
    row = _pn._current_row(rows, pn_seq)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pn_seq)

    repo = _cad_repo_path(cfg, pn)
    stp_path = os.path.join(repo, pn, "%s.stp" % pn)
    fcstd_path = os.path.join(repo, pn, "%s.FCStd" % pn)
    if not os.path.isfile(stp_path):
        return {"pn": pn, "ok": True, "skipped": "no supplier .stp on file"}
    if os.path.isfile(fcstd_path):
        return {"pn": pn, "ok": True, "skipped": "drawing already exists"}

    result = {"pn": pn, "ok": True, "pdfUploaded": False, "errors": []}
    tmpdir = tempfile.mkdtemp(prefix="gwtcad-supplier-drawing-")
    try:
        doc = App.newDocument(pn)
        try:
            shape = Part.Shape()
            shape.read(stp_path)
            part_obj = doc.addObject("Part::Feature", "SupplierModel")
            part_obj.Shape = shape
            part_obj.Label = row.get("mfg_pn") or pn
            doc.recompute()

            page_info = _drawing.create_page(doc, label="Drawing")
            page_id = page_info["id"]
            view_result = _drawing.make_view(doc, page_id, part_obj, direction="iso", scale=3.0)
            # Raw view.X/view.Y writes are silently ignored by export_page_svg
            # unless the view also carries the _gwt_placed tag (see
            # page_contents' 2026-09-20 fix comment) - set_view_position is
            # the real API that does both, same call the frontend's own
            # drag-to-place uses. Sheet is 420x297mm landscape with Y growing
            # downward from the top edge - (260, 90) puts the view in the
            # upper-right, well clear of the callout note in the lower-left
            # (verified by rendering, not guessed: an earlier (260, 200)
            # attempt ran the view off the bottom edge of the sheet).
            _drawing.set_view_position(doc, view_result["id"], 260.0, 90.0)

            note_text = "\n".join([
                "GWT PN:      %s" % pn,
                "Supplier:    %s" % (row.get("mfg") or "?"),
                "Supplier PN: %s" % (row.get("mfg_pn") or "?"),
                "Description: %s" % (row.get("description") or ""),
            ])
            # Note's Y grows upward from the bottom edge (opposite of the
            # view's Y, which grows downward from the top - verified by
            # rendering both, not assumed) - 250 puts this near the bottom
            # of a 297mm-tall sheet, i.e. visually well below the view above.
            _drawing.add_note(doc, page_id, note_text, x=20.0, y=250.0, textSize=6.0)
            doc.recompute()

            doc.saveAs(fcstd_path)

            svg = _drawing.export_page_svg(doc, page_id)
            svg_path = os.path.join(tmpdir, "%s.svg" % pn)
            with open(svg_path, "w", encoding="utf-8") as f:
                f.write(svg)

            pdf_path = os.path.join(tmpdir, "%s.pdf" % pn)
            import subprocess
            r = subprocess.run(["rsvg-convert", "-f", "pdf", "-o", pdf_path, svg_path],
                                capture_output=True, text=True, timeout=60)
            if r.returncode != 0 or not os.path.isfile(pdf_path):
                raise RuntimeError("rsvg-convert failed: %s" % (r.stderr or r.stdout))

            _storage.upload_file(pdf_path, "cad-exports/%s/%s.pdf" % (pn, pn), "application/pdf")
            result["pdfUploaded"] = True
        finally:
            App.closeDocument(doc.Name)
    except Exception as e:
        result["ok"] = False
        result["errors"].append(str(e))
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    if result["ok"]:
        _pn._sync_pull(repo)
        _pn._commit_and_push(
            repo, "%s: add reference drawing from supplier 3D model" % pn, lambda: True,
        )

    return result


@method("supplierModels.syncAndGenerateAll")
def sync_and_generate_all():
    """Convenience entry point for the startup-scan trigger: organize every
    pending supplier model, then generate a drawing for every PN that now
    has a .stp but no drawing yet. Returns both result lists."""
    sync_results = sync_supplier_models()
    organized_pns = [r["pn"] for r in sync_results if r.get("ok") and (r.get("path") or r.get("skipped") == "already organized")]
    drawing_results = []
    for pn in organized_pns:
        try:
            drawing_results.append(generate_supplier_drawing(pn))
        except RpcError as e:
            drawing_results.append({"pn": pn, "ok": False, "error": e.message})
    return {"sync": sync_results, "drawings": drawing_results}
