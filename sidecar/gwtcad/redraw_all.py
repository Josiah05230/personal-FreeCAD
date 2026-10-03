"""One-off job: redraw every drawing made before views were Y up
(drawing.YUP_TAG, 2026-10-03). Those pages show their front and right views
mirrored top to bottom, with a "bottom" view standing in for the top one -
see supplier_models._redraw_legacy_pages. Run as a freecadcmd script,
configured through the environment (freecadcmd swallows CLI arguments):
  GWTCAD_SIDECAR_DIR  - the sidecar directory to import gwtcad from
  GWTCAD_REDRAW_PN    - worker mode: redraw just this part (no git), print
                        a RESULT line and exit
Without GWTCAD_REDRAW_PN it coordinates, the same way draw_missing.py does:
one worker process per part, a few at a time, lightest file first, each
capped at WORKER_TIMEOUT_S; the coordinator alone commits, each finished
part by its exact path. Safe to run again - a page already current is
skipped.
No `__main__` guard: freecadcmd imports a script as a module named after
the file."""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.environ["GWTCAD_SIDECAR_DIR"])

from gwtcad import supplier_models as _sm  # noqa: E402

MAX_WORKERS = max(1, min(6, (os.cpu_count() or 2) - 2))
WORKER_TIMEOUT_S = 15 * 60


def _log(msg):
    print("[redraw] %s" % msg, flush=True)


def _worker(pn):
    try:
        r = _sm.redraw_part_drawing(pn)
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
    if _git(repo, "commit", "-m", "%s: drawing redrawn right side up" % pn, "--", *paths).returncode != 0:
        return
    for _ in range(3):
        if _git(repo, "push").returncode == 0:
            return
        _git(repo, "pull", "--no-rebase", "--no-edit")


def _coordinate():
    exe = os.path.join(_sm.App.getHomePath(), "bin", "freecadcmd")
    todo = _sm.legacy_drawing_candidates()
    _log("%d drawing(s) to check, %d at a time" % (len(todo), MAX_WORKERS))
    running, counts = {}, {"redrawn": 0, "skipped": 0, "failed": 0}
    while todo or running:
        while todo and len(running) < MAX_WORKERS:
            pn, path = todo.pop(0)
            env = dict(os.environ, GWTCAD_REDRAW_PN=pn)
            p = subprocess.Popen([exe, os.path.abspath(__file__)], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True)
            running[p] = (pn, path, time.time())
        for p, (pn, path, t0) in list(running.items()):
            if p.poll() is None:
                if time.time() - t0 > WORKER_TIMEOUT_S:
                    p.kill()
                    p.wait()
                    del running[p]
                    counts["failed"] += 1
                    _log("%s: gave up after %d min" % (pn, WORKER_TIMEOUT_S // 60))
                continue
            del running[p]
            result = None
            for line in (p.stdout.read() or "").splitlines():
                if line.startswith("RESULT "):
                    result = json.loads(line[len("RESULT "):])
            if result and result.get("redrawn"):
                _commit(result["repo"], result["path"], pn)
                counts["redrawn"] += 1
                _log("%s: %s in %.0fs%s" % (pn, "+".join(result["redrawn"]), time.time() - t0,
                                             "" if result.get("pdfUploaded") else " (PDF not uploaded)"))
            elif result and result.get("ok"):
                counts["skipped"] += 1
                _log("%s: %s" % (pn, result.get("skipped") or "nothing to do"))
            else:
                counts["failed"] += 1
                _log("%s: FAILED %s" % (pn, (result or {}).get("error") or "no result"))
        time.sleep(0.5)
    _log("done: %(redrawn)d redrawn, %(skipped)d skipped, %(failed)d failed" % counts)


if os.environ.get("GWTCAD_REDRAW_PN"):
    _worker(os.environ["GWTCAD_REDRAW_PN"])
else:
    _coordinate()
