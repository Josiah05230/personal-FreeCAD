"""Full-quality meshes for heavy shapes, built off the engine thread.

scene.get shows a heavy shape (a PCBA with hundreds of drilled holes) as a
quick draft first and hands the shape to this pool: a few persistent
freecadcmd worker processes (mesh_worker.py), so meshing runs in parallel
and never holds up the engine thread - OCCT holds the GIL, so a thread in
this process would freeze every other RPC while it meshed.

Jobs are keyed (path, object name, shape signature). The engine thread
submits them (exporting the shape to a BREP file, ~0.1s) and later collects
finished buffers with take_results(); the caller decides whether a result
still matches what is on screen. Worker threads here only do pipe I/O and
JSON loading - never document access.
"""
import itertools
import json
import os
import queue
import subprocess
import tempfile
import threading

import FreeCAD as App

POOL_SIZE = max(1, min(3, (os.cpu_count() or 2) // 2))
JOB_TIMEOUT_S = 180

_LOCK = threading.Lock()
_JOBS = queue.Queue()
_INFLIGHT = {}   # key -> job id
_FAILED = set()  # keys that failed or timed out - don't retry them
_RESULTS = []    # (key, buffer) waiting for take_results()
_IDS = itertools.count(1)
_state = {"started": False, "tmp": None}


def _log(msg):
    print("[mesh-pool] %s" % msg, flush=True)


def _spawn():
    exe = os.path.join(App.getHomePath(), "bin", "freecadcmd")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = dict(os.environ, GWTCAD_SIDECAR_DIR=here)
    env.pop("GWTCAD_PORT", None)
    # stdin is a pipe: the worker exits on EOF, i.e. when the sidecar dies
    p = subprocess.Popen([exe, os.path.join(here, "gwtcad", "mesh_worker.py")], env=env,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1)
    lines = queue.Queue()

    def _reader():
        for line in p.stdout:
            if line.startswith("GWTMESH_"):
                lines.put(line.strip())
        lines.put(None)  # process ended

    threading.Thread(target=_reader, name="gwtcad-mesh-reader", daemon=True).start()
    return p, lines


def _serve():
    try:
        proc = _spawn()  # start now, so the first job doesn't wait on FreeCAD's startup
    except Exception as e:  # noqa: BLE001
        _log("spawn failed: %s" % e)
        proc = None
    while True:
        jid, key, brep = _JOBS.get()
        out = brep[:-5] + ".json"
        ok = False
        try:
            if proc is None or proc[0].poll() is not None:
                proc = _spawn()
            p, lines = proc
            p.stdin.write(json.dumps({"job": jid, "brep": brep, "out": out}) + "\n")
            p.stdin.flush()
            while True:
                line = lines.get(timeout=JOB_TIMEOUT_S)
                if line is None:
                    raise RuntimeError("worker exited")
                tag, _, rest = line.partition(" ")
                if rest.split(" ", 1)[0] != str(jid):
                    continue
                if tag == "GWTMESH_DONE":
                    with open(out) as f:
                        buf = json.load(f)
                    with _LOCK:
                        _RESULTS.append((key, buf))
                    ok = True
                else:
                    _log("job %s failed: %s" % (jid, rest))
                break
        except queue.Empty:
            _log("job %s timed out after %ds" % (jid, JOB_TIMEOUT_S))
            try:
                proc[0].kill()
            except Exception:
                pass
            proc = None
        except Exception as e:  # noqa: BLE001 - the pool thread must never die
            _log("job %s error: %s" % (jid, e))
            proc = None
        finally:
            with _LOCK:
                _INFLIGHT.pop(key, None)
                if not ok:
                    _FAILED.add(key)
            for f in (brep, out):
                try:
                    os.remove(f)
                except OSError:
                    pass


def _ensure_started():
    if _state["started"]:
        return
    _state["tmp"] = tempfile.mkdtemp(prefix="gwtcad-mesh-")
    for _ in range(POOL_SIZE):
        threading.Thread(target=_serve, name="gwtcad-mesh-pool", daemon=True).start()
    _state["started"] = True


def warm():
    """Start the worker processes ahead of the first job (document.open)."""
    try:
        _ensure_started()
    except Exception as e:  # noqa: BLE001
        _log("warm failed: %s" % e)


def submit(key, shape):
    """Queue a full-quality mesh of `shape` (engine thread only). Returns True
    when a job is queued or already running for this key."""
    with _LOCK:
        if key in _INFLIGHT:
            return True
        if key in _FAILED:
            return False
    try:
        _ensure_started()
        jid = next(_IDS)
        brep = os.path.join(_state["tmp"], "%d.brep" % jid)
        shape.exportBrep(brep)
    except Exception as e:  # noqa: BLE001
        _log("submit failed: %s" % e)
        return False
    with _LOCK:
        _INFLIGHT[key] = jid
    _JOBS.put((jid, key, brep))
    return True


def failed(key):
    with _LOCK:
        return key in _FAILED


def pending(path):
    """Jobs still queued or running for this document path."""
    with _LOCK:
        return sum(1 for k in _INFLIGHT if k[0] == path)


def take_results():
    """[(key, buffer)] finished since the last call."""
    with _LOCK:
        out = list(_RESULTS)
        del _RESULTS[:]
    return out
