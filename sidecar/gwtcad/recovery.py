"""Crash recovery: periodic autosave-to-temp for the currently open
document, and detecting/offering/discarding a leftover recovery copy on
the NEXT open of that same file.

Deliberately a pure side channel, never touching the real file, the
document's own FileName, or git:
  - FreeCAD's Document.saveCopy(path) writes a copy WITHOUT retargeting
    the document the way saveAs does (verified: after saveCopy, .save()
    still writes to the ORIGINAL path) - autosave_current uses exactly
    that, so a periodic autosave can never accidentally redirect a later
    real Save.
  - Recovery files live under ~/.gwtcad/recovery/, named by a hash of the
    real file's absolute path (not the filename alone, so two same-named
    parts in different folders never collide) - never inside the user's
    actual project repo, so they can never get committed/pushed by
    accident.
  - A recovery file only matters if the crash happened AFTER the real
    file was last saved (otherwise the real file already has whatever
    the recovery copy has, or newer) - check_recovery compares mtimes and
    reports nothing if the recovery copy isn't actually ahead.
"""
import hashlib
import os
import time

import FreeCAD as App

from . import session

_RECOVERY_DIR = os.path.expanduser("~/.gwtcad/recovery")


def _recovery_path(real_path):
    real_abs = os.path.abspath(os.path.expanduser(real_path))
    digest = hashlib.sha256(real_abs.encode("utf-8")).hexdigest()[:16]
    return os.path.join(_RECOVERY_DIR, "%s.FCStd" % digest)


def autosave_current():
    """Snapshot the currently open document to its recovery path, if it
    has one (unsaved-ever documents with no real path yet have nowhere
    meaningful to recover TO, so they're skipped - out of scope for this
    pass, matches the "recover a previously-saved file" framing this
    feature was scoped to). No-op, not an error, when there's no open
    document or it has never been saved."""
    d = session.doc(create=False)
    if d is None:
        return {"saved": False, "reason": "no open document"}
    real_path = session.path()
    if not real_path:
        return {"saved": False, "reason": "document has no path yet (never saved)"}
    os.makedirs(_RECOVERY_DIR, exist_ok=True)
    rec_path = _recovery_path(real_path)
    d.saveCopy(rec_path)
    # saveCopy doesn't touch FileName, but it DOES leave the doc's own
    # "modified" flag cleared in some FreeCAD versions - explicitly leave
    # that alone here (nothing to do; UndoMode/mustExecute are unaffected)
    # since the real unsaved-changes indicator lives in the renderer's own
    # dirty flag, not anything read from the FreeCAD document object.
    return {"saved": True, "recoveryPath": rec_path}


def check_recovery(real_path):
    """Does a NEWER recovery copy exist for real_path than the real file
    itself? Only meaningful right after opening real_path, before any
    edits - the caller (document.open's RPC surface, or the renderer
    right after it) decides when to ask. Returns enough for the renderer
    to show a real choice, not just a yes/no."""
    rec_path = _recovery_path(real_path)
    if not os.path.isfile(rec_path):
        return {"available": False}
    real_abs = os.path.abspath(os.path.expanduser(real_path))
    if not os.path.isfile(real_abs):
        # the real file is gone entirely (shouldn't normally happen - the
        # caller already opened it) - still worth surfacing the recovery
        # copy rather than silently discarding it.
        return {"available": True, "recoveryPath": rec_path, "recoveryMtime": os.path.getmtime(rec_path)}
    rec_mtime = os.path.getmtime(rec_path)
    real_mtime = os.path.getmtime(real_abs)
    if rec_mtime <= real_mtime:
        # the real file is at least as new - nothing to recover, and this
        # is also where a NORMAL save (which the user's own real Save
        # already handles) makes a stale recovery copy irrelevant.
        return {"available": False}
    return {
        "available": True,
        "recoveryPath": rec_path,
        "recoveryMtime": rec_mtime,
        "realMtime": real_mtime,
        "ageSeconds": time.time() - rec_mtime,
    }


def discard_recovery(real_path):
    """Delete real_path's recovery copy - called once the user has either
    recovered it (opened it, will Save As over the real file themselves)
    or explicitly declined it. Safe to call when none exists."""
    rec_path = _recovery_path(real_path)
    try:
        os.remove(rec_path)
    except FileNotFoundError:
        pass
    return {"ok": True}
