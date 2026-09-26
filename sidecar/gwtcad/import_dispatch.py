"""Universal "Import from File": inspect whatever the user hands us (a zip,
a bare STEP/mesh, a KiCad board/project file), classify every file in it,
and place the ECAD half into an F part's folder once the UI has reserved
the PN(s).

Deliberately split from the actual reserve/save steps: the UI shows the
classification (with a per-STEP override) BEFORE anything is committed,
then runs the existing New Part flow once or twice. This module only
answers "what is in here" and "copy the ECAD files there".

No FreeCAD import - classification is plain file/zip/regex work, so it
runs (and is tested) under plain pytest.
"""
import os
import re
import shutil
import tempfile
import zipfile

from .registry import method, RpcError, APP_ERROR

_TMP_PREFIX = "gwtcad-import-"

KICAD_EXTS = (".kicad_pro", ".kicad_pcb", ".kicad_sch", ".kicad_prl", ".kicad_sym",
              ".kicad_mod", ".kicad_dru", ".kicad_wks")
KICAD_NAMES = ("fp-lib-table", "sym-lib-table")
STEP_EXTS = (".step", ".stp")
OTHER_MODEL_EXTS = (".iges", ".igs", ".brep", ".brp", ".stl", ".obj", ".3mf", ".ply", ".off")
# VRML is only ever a KiCad footprint render model, never a standalone part
FOOTPRINT_ONLY_EXTS = (".wrl",)

_MODEL_RE = re.compile(r'\(model\s+"?([^"\s)]+)"?')


def _stem(p):
    return os.path.splitext(os.path.basename(p))[0].lower()


def _board_model_stems(pcb_paths):
    """Every 3D-model filename stem any footprint in these boards references
    via (model "...") - e.g. "${KIPRJMOD}/shapes/USB_C.step" -> "usb_c".
    Matched by stem, not full path: a zip's internal layout never matches
    KiCad's ${VAR}-prefixed paths literally, and a .wrl reference usually
    has a same-named .step sibling (kicad-cli's --subst-models relies on
    exactly that convention)."""
    stems = {}
    for pcb in pcb_paths:
        try:
            text = open(pcb, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for m in _MODEL_RE.finditer(text):
            stems.setdefault(_stem(m.group(1)), m.group(1))
    return stems


def _safe_extract(zip_path, dest):
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            # zip-slip guard: never write outside dest
            target = os.path.realpath(os.path.join(dest, name))
            if not target.startswith(os.path.realpath(dest) + os.sep):
                raise RpcError(APP_ERROR, "refusing unsafe path in zip: %r" % name)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def classify(root):
    """Classify every file under root. Returns the inspect() payload minus
    extractDir. Roles:
      kicad       - part of the KiCad project itself
      footprint   - a STEP/VRML model a footprint in the board references
                    (stays with the board, same F PN)
      mechanical  - a standalone 3D model (its own mechanical PN)
      attachment  - anything else (gerbers, PDFs, BOM CSVs...) - rides with
                    the KiCad project when there is one, else ignored
    """
    all_files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__MACOSX"]
        for fn in filenames:
            if fn.startswith("."):
                continue
            all_files.append(os.path.relpath(os.path.join(dirpath, fn), root))
    all_files.sort()

    pcbs = [f for f in all_files if f.lower().endswith(".kicad_pcb")]
    model_stems = _board_model_stems([os.path.join(root, p) for p in pcbs])

    files = []
    for rel in all_files:
        low = rel.lower()
        base = os.path.basename(low)
        entry = {"relpath": rel, "role": "attachment", "matchedModel": None}
        if low.endswith(KICAD_EXTS) or base in KICAD_NAMES:
            entry["role"] = "kicad"
        elif low.endswith(STEP_EXTS + FOOTPRINT_ONLY_EXTS):
            match = model_stems.get(_stem(rel))
            if match is not None:
                entry["role"] = "footprint"
                entry["matchedModel"] = match
            elif low.endswith(FOOTPRINT_ONLY_EXTS):
                # an unreferenced .wrl is still only ever a footprint model
                entry["role"] = "footprint" if pcbs else "attachment"
            else:
                entry["role"] = "mechanical"
        elif low.endswith(OTHER_MODEL_EXTS):
            entry["role"] = "mechanical"
        files.append(entry)

    return {
        "files": files,
        "hasKicad": bool(pcbs),
        "pcb": pcbs[0] if pcbs else None,
    }


@method("importDispatch.inspect")
def inspect(path):
    """Unpack (if a zip) into a private temp dir and classify. A bare file
    is copied into the temp dir too, so every later step works from one
    uniform place regardless of what the user picked. The caller must
    eventually call importDispatch.cleanup(extractDir)."""
    path = os.path.abspath(os.path.expanduser(path or ""))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "file not found: %s" % path)
    extract_dir = tempfile.mkdtemp(prefix=_TMP_PREFIX)
    try:
        if zipfile.is_zipfile(path):
            _safe_extract(path, extract_dir)
        else:
            shutil.copy2(path, os.path.join(extract_dir, os.path.basename(path)))
            # a bare .kicad_pcb/.kicad_pro picked by itself: bring the rest of
            # its project folder along (schematic, project file, local 3D
            # model folders) - picking one file of a KiCad project means
            # "this project", not literally that one file.
            if path.lower().endswith((".kicad_pcb", ".kicad_pro", ".kicad_sch")):
                src_dir = os.path.dirname(path)
                for name in os.listdir(src_dir):
                    s = os.path.join(src_dir, name)
                    d = os.path.join(extract_dir, name)
                    if os.path.exists(d) or name.startswith("."):
                        continue
                    if os.path.isdir(s):
                        if name.endswith("-backups"):
                            continue
                        shutil.copytree(s, d)
                    else:
                        shutil.copy2(s, d)
        result = classify(extract_dir)
    except Exception:
        shutil.rmtree(extract_dir, ignore_errors=True)
        raise
    result["extractDir"] = extract_dir
    result["sourceName"] = os.path.splitext(os.path.basename(path))[0]
    return result


def _check_extract_dir(extract_dir):
    real = os.path.realpath(extract_dir or "")
    tmp = os.path.realpath(tempfile.gettempdir())
    if not (os.path.dirname(real) == tmp and os.path.basename(real).startswith(_TMP_PREFIX)):
        raise RpcError(APP_ERROR, "not an import staging dir: %s" % extract_dir)
    return real


@method("importDispatch.placeEcad")
def place_ecad(extractDir, relpaths, destDir):
    """Copy the given (kicad/footprint/attachment) files into an F part's
    folder, preserving their layout RELATIVE TO THE BOARD's own folder so
    ${KIPRJMOD}/shapes/... model references keep resolving after the move.
    Files outside the board's folder land at destDir/<their own relpath>.
    Never overwrites an existing file (returns it under "skipped")."""
    root = _check_extract_dir(extractDir)
    dest = os.path.abspath(destDir)
    os.makedirs(dest, exist_ok=True)
    pcbs = [r for r in relpaths if r.lower().endswith(".kicad_pcb")]
    board_dir = os.path.dirname(pcbs[0]) if pcbs else ""

    placed, skipped = [], []
    for rel in relpaths:
        src = os.path.realpath(os.path.join(root, rel))
        if not src.startswith(root + os.sep) or not os.path.isfile(src):
            continue
        if board_dir and (rel == board_dir or rel.startswith(board_dir + os.sep)):
            out_rel = os.path.relpath(rel, board_dir)
        else:
            out_rel = rel
        out = os.path.join(dest, out_rel)
        if os.path.exists(out):
            skipped.append(out)
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        placed.append(out)

    def first(ext):
        for p in placed + skipped:
            if p.lower().endswith(ext) and os.path.dirname(p) == dest:
                return p
        return None

    return {"placed": placed, "skipped": skipped, "pcbPath": first(".kicad_pcb"),
            "schPath": first(".kicad_sch"), "proPath": first(".kicad_pro")}


@method("importDispatch.cleanup")
def cleanup(extractDir):
    """Delete a staging dir inspect() created - refuses anything else."""
    try:
        real = _check_extract_dir(extractDir)
    except RpcError:
        return {"ok": False}
    shutil.rmtree(real, ignore_errors=True)
    return {"ok": True}
