"""GWT-CAD headless sidecar.

Runs under FreeCAD's bundled interpreter via `freecadcmd sidecar/server.py`.
Owns the FreeCAD document and answers JSON-RPC calls from the Electron shell.
"""

import sys as _sys
import types as _types

__version__ = "0.0.0"

# The Assembly workbench's Preferences.py imports FreeCADGui unconditionally
# (only its GUI preferences page uses it), and JointObject imports
# Preferences. freecadcmd ships no GUI library, so that import failed:
# every saved joint's proxy failed to restore on open, and add_joint fell
# back to a non-solving record. It lives here, not in server.py, so every
# entry point gets it - the background drawing worker (draw_missing) ran
# without it and its saves wrote every assembly's joints out dead. An
# empty stand-in is enough - the rest of the joint code only touches
# FreeCADGui when App.GuiUp.
if "FreeCADGui" not in _sys.modules:
    try:
        import FreeCADGui  # noqa: F401
    except ImportError:
        _sys.modules["FreeCADGui"] = _types.ModuleType("FreeCADGui")
