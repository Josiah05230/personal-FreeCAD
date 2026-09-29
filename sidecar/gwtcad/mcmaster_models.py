"""Automatic McMaster-Carr 3D models for registry parts.

McMaster has no open model API like Aptiv's, and its CAD file server sits
behind Akamai bot mitigation, so the GrainWavePartners Cloud Function can't
fetch these the way tryFetchSupplierModel does for Aptiv. GWT-CAD can: the
Electron main process loads the part's page in a hidden window and fetches
the STEP from inside it (see fetchStepHeadless in app/src/main/mcmaster.ts).

This module is the sidecar half of that loop:
  * mcmasterModels.listMissing - registry parts from McMaster-Carr with an
    mfg_pn but no model yet (no <PN>.stp in pn-cad-files and no supplier ZIP
    waiting in Storage).
  * mcmasterModels.uploadStep - wraps a fetched STEP as
    cad-exports/<PN>/<PN>_supplier_model.zip (+ _supplier_meta.json), the
    same drop-off the Aptiv fetch uses.

From there the existing supplierModels.syncAndGenerateAll pipeline organizes
the .stp into pn-cad-files and generates the reference drawing - nothing in
supplier_models.py needs to know where the ZIP came from.
"""
import io
import json
import os
import re
import zipfile

from .registry import method, RpcError, APP_ERROR
from . import partnumbers as _pn
from . import firebase_storage as _storage
from . import supplier_models as _supplier_models

_MCMASTER = re.compile(r"mc-?master", re.I)


@method("mcmasterModels.listMissing")
def list_missing():
    cfg = _pn._load_config()
    if not cfg.get("registryPath"):
        return []
    _pn._sync_pull_for_read(_pn._registry_path(cfg))
    rows = _pn._read_registry(cfg)
    try:
        waiting = {n.split("/")[1] for n in _storage.list_objects("cad-exports/")
                   if n.endswith("_supplier_model.zip")}
    except RpcError:
        return []  # no Firebase key / offline - nothing could be uploaded either
    out = []
    for row in _pn._current_rows(rows):
        pn, mfg_pn = row.get("pn"), (row.get("mfg_pn") or "").strip()
        if not pn or not mfg_pn or not _MCMASTER.search(row.get("mfg") or ""):
            continue
        if row.get("lifecycle") == "discontinued" or pn in waiting:
            continue
        try:
            repo = _supplier_models._cad_repo_path(cfg, pn)
            folder = _supplier_models._part_folder(cfg, repo, pn, row)
        except RpcError:
            continue
        if os.path.isfile(os.path.join(folder, "%s.stp" % pn)) or os.path.isfile(os.path.join(folder, "%s.FCStd" % pn)):
            continue
        out.append({"pn": pn, "mfgPn": mfg_pn, "description": row.get("description") or ""})
    return out


@method("mcmasterModels.uploadStep")
def upload_step(pn, path, mfgPn, description=""):
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"ISO-10303-21"):
        raise RpcError(APP_ERROR, "%s: fetched file is not a STEP file" % pn)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("%s.stp" % pn, data)
    base = "cad-exports/%s/%s" % (pn, pn)
    # meta first: sync treats the ZIP as the signal, so its meta must already be there
    _storage.upload_bytes(base + "_supplier_meta.json", json.dumps({
        "supplier": "mcmaster-carr", "supplierPn": mfgPn, "description": description,
    }).encode(), "application/json")
    _storage.upload_bytes(base + "_supplier_model.zip", buf.getvalue(), "application/zip")
    return {"pn": pn, "bytes": len(data)}
