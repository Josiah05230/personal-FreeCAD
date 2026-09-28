"""Background job: draw every part that has geometry but no drawing
(supplier_models.generate_missing_drawings) in its own freecadcmd process,
so the app's single engine thread never waits on hidden-line removal.
Started by supplierModels.syncAndGenerateAll; run as a script, configured
through the environment (freecadcmd swallows CLI arguments):
  GWTCAD_SIDECAR_DIR  - the sidecar directory to import gwtcad from
No `__main__` guard: freecadcmd imports a script as a module named after
the file."""
import os
import sys

sys.path.insert(0, os.environ["GWTCAD_SIDECAR_DIR"])

from gwtcad import supplier_models as _sm  # noqa: E402
from gwtcad.paths import config_path  # noqa: E402

_LOCK = config_path("draw-missing.lock")


def _run():
    try:
        fd = os.open(_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        # another scan is running, unless that one died
        try:
            pid = int(open(_LOCK).read().strip() or 0)
            os.kill(pid, 0)
            return
        except (ValueError, ProcessLookupError, PermissionError):
            os.remove(_LOCK)
            fd = os.open(_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    try:
        for r in _sm.generate_missing_drawings():
            print("[draw-missing] %s" % r, flush=True)
    finally:
        os.remove(_LOCK)


_run()
