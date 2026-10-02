"""Joints saved without their proxy solve again on open - run under
freecadcmd (see sidecar/scripts/run_tests.sh). pn-cad-files GWT-CAD-NEEDS.md #3.

The background drawing worker opened assemblies without the FreeCADGui
stand-in, so JointObject couldn't import, every joint restored with Proxy
None, and the drawing save wrote them out dead: a part change never moved
the parts joined to it.
"""
import os

import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App
import Part

from gwtcad import assembly


def _part(path, name, size):
    d = App.newDocument(name)
    d.addObject("Part::Feature", "Shape").Shape = Part.makeBox(*size)
    d.recompute()
    d.saveAs(path)
    return d


def _top_face(link):
    shape = link.LinkedObject.Shape
    return "Face%d" % (1 + max(range(len(shape.Faces)), key=lambda i: shape.Faces[i].CenterOfMass.z))


def _bottom_face(link):
    shape = link.LinkedObject.Shape
    return "Face%d" % (1 + min(range(len(shape.Faces)), key=lambda i: shape.Faces[i].CenterOfMass.z))


def test_dead_joints_revive_and_follow_a_part_change(tmp_path):
    base_p, lid_p, asm_p = (str(tmp_path / n) for n in ("base.FCStd", "lid.FCStd", "asm.FCStd"))
    base = _part(base_p, "Base", (20, 20, 10))
    lid = _part(lid_p, "Lid", (20, 20, 2))
    asm = App.newDocument("Asm")
    asm.saveAs(asm_p)
    assembly.get_or_make_assembly(asm)
    a = assembly.add_component(asm, base_p, name="BaseC")
    assembly.ground(asm, a.Name)
    b = assembly.add_component(asm, lid_p, name="LidC")
    assembly.add_joint(asm, "Fixed", a.Name, _top_face(a), b.Name, _bottom_face(b))
    asm.recompute()
    joints = [o for o in asm.Objects if "JointType" in o.PropertiesList]
    assert joints and all(o.Proxy is not None for o in joints)
    # what the old worker's save produced
    for o in asm.Objects:
        if "JointType" in o.PropertiesList or "ObjectToGround" in o.PropertiesList:
            o.Proxy = None
    asm.save()
    for d in (asm, base, lid):
        App.closeDocument(d.Name)

    asm = App.openDocument(asm_p)
    base = next(d for d in App.listDocuments().values() if d.FileName == base_p)
    try:
        assert any(o.TypeId == "App::FeaturePython" and o.Proxy is None for o in asm.Objects)
        assert assembly.revive_joints(asm) >= 1
        assert all(o.Proxy is not None for o in asm.Objects if "JointType" in o.PropertiesList)
        assert assembly.revive_joints(asm) == 0  # idempotent

        lid_link = asm.getObject("LidC")
        z0 = lid_link.Placement.Base.z
        base.getObject("Shape").Shape = Part.makeBox(20, 20, 11)  # base 1mm taller
        base.recompute()
        for o in asm.Objects:
            o.touch()
        asm.recompute()
        asm_obj = assembly.get_or_make_assembly(asm)
        asm_obj.solve()
        asm.recompute()
        assert abs(lid_link.Placement.Base.z - z0 - 1.0) < 1e-6
    finally:
        for d in list(App.listDocuments().values()):
            if os.path.dirname(d.FileName or "") == str(tmp_path):
                App.closeDocument(d.Name)
