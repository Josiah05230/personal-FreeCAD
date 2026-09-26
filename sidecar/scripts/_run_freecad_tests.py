"""Helper invoked by run_tests.sh under the bundled freecadcmd's Python -
runs the test files that need a real FreeCAD import (supplier_models.py
imports FreeCAD/Part at module load time, so plain pytest can't collect
its tests at all). Not meant to be run directly; see run_tests.sh.

Configured entirely through environment variables, NOT sys.argv:
freecadcmd's own CLI treats trailing positional args as "File1 File2 ..."
to open (see `freecadcmd --help` - it's a "Usage: FreeCAD [options] File1
File2 ..." app, not a generic script runner), so plumbing arguments
through argv is unreliable. Env vars sidestep that entirely.

No `if __name__ == "__main__":` guard on purpose: freecadcmd runs a script
file as an IMPORTED MODULE named after the file (confirmed: __name__ is
"_run_freecad_tests", never "__main__"), unlike `python script.py` - that
guard would silently skip this file's entire body under freecadcmd.
"""
import os
import sys

sys.path.insert(0, os.environ["GWTCAD_TEST_SIDECAR_DIR"])
sys.path.insert(0, os.environ["GWTCAD_TEST_SITE_PACKAGES"])
import pytest

sys.exit(pytest.main([os.environ["GWTCAD_TEST_TARGET"]]))
