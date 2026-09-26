"""Builds a minimal real .kicad_pcb (one populated footprint with a real
STEP-format 3D model, plus a board outline) at the path given as argv[1].
Run under SYSTEM python3, never FreeCAD's bundled Python - pcbnew (KiCad's
own scripting module) lives in system Python's site-packages, not
FreeCAD's, so this must be a separate subprocess from any FreeCAD-tier
test that needs the resulting file. See test_kicad.py.
"""
import sys

import pcbnew

out_path = sys.argv[1]

board = pcbnew.CreateEmptyBoard()
fp = pcbnew.FootprintLoad("/usr/share/kicad/footprints/Inductor_SMD.pretty", "L_0603_1608Metric")
if fp is None:
    print("SKIP: system KiCad footprint library not installed", file=sys.stderr)
    sys.exit(2)
fp.SetPosition(pcbnew.VECTOR2I_MM(10, 10))
fp.SetReference("L1")
board.Add(fp)

outline = pcbnew.PCB_SHAPE(board)
outline.SetShape(pcbnew.SHAPE_T_RECT)
outline.SetStart(pcbnew.VECTOR2I_MM(0, 0))
outline.SetEnd(pcbnew.VECTOR2I_MM(20, 20))
outline.SetLayer(pcbnew.Edge_Cuts)
board.Add(outline)

pcbnew.SaveBoard(out_path, board)
