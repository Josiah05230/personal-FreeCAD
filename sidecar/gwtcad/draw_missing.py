"""Background job: draw every part that has geometry but no drawing, off
the app's single engine thread. Started by supplierModels.syncAndGenerateAll;
run as a freecadcmd script, configured through the environment (freecadcmd
swallows CLI arguments):
  GWTCAD_SIDECAR_DIR  - the sidecar directory to import gwtcad from
  GWTCAD_DRAW_PN      - worker mode: draw just this part (no git), print a
                        RESULT line and exit
Without GWTCAD_DRAW_PN it coordinates: one worker process per part, a few
at a time, lightest file first, each capped at WORKER_TIMEOUT_S - hidden-
line removal on a heavy model (a perfboard's hundreds of holes) can take
many minutes, and it must never hold up the rest. The coordinator alone
commits, each finished part by its exact path (workers may be mid-save on
other files in the same repo).
No `__main__` guard: freecadcmd imports a script as a module named after
the file."""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.environ["GWTCAD_SIDECAR_DIR"])

from gwtcad import supplier_models as _sm  # noqa: E402
from gwtcad.paths import config_path  # noqa: E402

MAX_WORKERS = max(1, min(6, (os.cpu_count() or 2) - 2))
WORKER_TIMEOUT_S = 15 * 60
_LOCK = config_path("draw-missing.lock")


def _log(msg):
    print("[draw-missing] %s" % msg, flush=True)


def _worker(pn):
    try:
        r = _sm.generate_part_drawing(pn, commit=False)
    except Exception as e:
        r = {"pn": pn, "ok": False, "error": str(e)}
    print("RESULT " + json.dumps(r), flush=True)


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True)


def _commit(repo, path, pn):
    rel = os.path.relpath(path, repo)
    companion = rel + ".gwtcad.json"
    paths = [rel] + ([companion] if os.path.isfile(os.path.join(repo, companion)) else [])
    _git(repo, "add", "--", *paths)
    if _git(repo, "commit", "-m", "%s: add auto-generated drawing" % pn, "--", *paths).returncode != 0:
        return
    for _ in range(3):
        if _git(repo, "push").returncode == 0:
            return
        _git(repo, "pull", "--no-rebase", "--no-edit")


def _coordinate():
    exe = os.path.join(_sm.App.getHomePath(), "bin", "freecadcmd")
    todo = _sm.missing_drawing_candidates()
    _log("%d part(s) need a drawing, %d at a time" % (len(todo), MAX_WORKERS))
    running = {}
    while todo or running:
        while todo and len(running) < MAX_WORKERS:
            pn, path = todo.pop(0)
            env = dict(os.environ, GWTCAD_DRAW_PN=pn)
            p = subprocess.Popen([exe, os.path.abspath(__file__)], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True)
            running[p] = (pn, path, time.time())
        for p, (pn, path, t0) in list(running.items()):
            if p.poll() is None:
                if time.time() - t0 > WORKER_TIMEOUT_S:
                    p.kill()
                    p.wait()
                    del running[p]
                    _log("%s: gave up after %d min (too heavy to draw automatically)" % (pn, WORKER_TIMEOUT_S // 60))
                continue
            del running[p]
            result = None
            for line in (p.stdout.read() or "").splitlines():
                if line.startswith("RESULT "):
                    result = json.loads(line[len("RESULT "):])
            if result and result.get("generated"):
                _commit(result["repo"], result["path"], pn)
                _log("%s: drawn in %.0fs" % (pn, time.time() - t0))
            else:
                _log("%s: %s" % (pn, (result or {}).get("skipped") or (result or {}).get("error") or "no result"))
        time.sleep(0.5)


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
        _coordinate()
    finally:
        os.remove(_LOCK)


if os.environ.get("GWTCAD_DRAW_PN"):
    _worker(os.environ["GWTCAD_DRAW_PN"])
else:
    _run()
