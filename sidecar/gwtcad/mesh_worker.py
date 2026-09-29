"""Background mesh worker: a persistent freecadcmd process that turns shapes
into full-quality render buffers off the engine thread (see mesh_pool).
Configured through the environment (freecadcmd swallows CLI arguments):
  GWTCAD_SIDECAR_DIR  - the sidecar directory to import gwtcad from
Protocol, one JSON object per line on stdin:
  {"job": <id>, "brep": <path>, "out": <path>}
It reads the shape from `brep`, writes the tessellate_shape() buffer as JSON
to `out`, and prints `GWTMESH_DONE <id>` (or `GWTMESH_FAIL <id> <msg>`).
FreeCAD may print its own noise on stdout, so the pool only reads lines with
those prefixes. Exits when stdin closes (the sidecar is gone).
No `__main__` guard: freecadcmd imports a script as a module named after
the file."""
import json
import os
import sys

sys.path.insert(0, os.environ["GWTCAD_SIDECAR_DIR"])

import Part  # noqa: E402

from gwtcad.tessellate import tessellate_shape  # noqa: E402


def _run():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = None
        try:
            req = json.loads(line)
            job = req["job"]
            shape = Part.Shape()
            shape.read(req["brep"])
            buf = tessellate_shape(shape)
            tmp = req["out"] + ".part"
            with open(tmp, "w") as f:
                json.dump(buf, f)
            os.replace(tmp, req["out"])
            print("GWTMESH_DONE %s" % job, flush=True)
        except Exception as e:  # noqa: BLE001 - report and keep serving
            print("GWTMESH_FAIL %s %s" % (job, str(e).replace("\n", " ")), flush=True)


_run()
os._exit(0)
