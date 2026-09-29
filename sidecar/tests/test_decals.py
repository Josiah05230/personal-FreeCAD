"""Face decals - run under freecadcmd (see sidecar/scripts/run_tests.sh).

(a) a decal on a box's top face shows up in scene.get with the right frame and
    round-trips through the companion;
(b) the same part linked into an assembly at a translated + rotated placement
    yields the decal moved with the link, and again one level deeper through a
    sub-assembly.
"""
import json
import math
import os
import struct
import zlib

import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App
from FreeCAD import Vector, Placement, Rotation

from gwtcad import methods, session, decals
from gwtcad import assembly as _assembly
from gwtcad.registry import RpcError


def _png(path, w, h):
    raw = b"".join(b"\x00" + b"\xff\x00\x00\x80" * w for _ in range(h))

    def chunk(t, data):
        return (struct.pack(">I", len(data)) + t + data
                + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


BODY_PL = Placement(Vector(1, 2, 3), Rotation(Vector(0, 0, 1), 10))


def _save_lid(path):
    """A 40 x 20 x 5 box body, placed off the origin, plus a cylinder."""
    d = App.newDocument("lid")
    b = d.addObject("PartDesign::Body", "Body")
    bx = b.newObject("PartDesign::AdditiveBox", "Box")
    bx.Length, bx.Width, bx.Height = 40, 20, 5
    b.Placement = BODY_PL
    b2 = d.addObject("PartDesign::Body", "Round")
    b2.newObject("PartDesign::AdditiveCylinder", "Cyl")
    d.recompute()
    d.saveAs(str(path))
    App.closeDocument(d.Name)


def _face_index(o, normal):
    for i, f in enumerate(o.Shape.Faces):
        if decals._is_planar(f) and decals._face_normal(f).dot(normal) > 0.999:
            return i
    raise AssertionError("no face with normal %r" % normal)


def _mesh(scene, name):
    return next(m for m in scene["meshes"] if m["id"] == name)


def _close(a, b, tol=1e-6):
    return all(abs(x - y) < tol for x, y in zip(a, b))


def _on_face(shape, dec, tol=1e-6):
    """The decal centre lies in the plane of some face of `shape` whose
    outward normal is the decal's normal - an independent check of the
    composed transform against the real linked geometry."""
    c, n = Vector(*dec["center"]), Vector(*dec["normal"])
    for f in shape.Faces:
        if not decals._is_planar(f):
            continue
        fn = decals._face_normal(f)
        if fn.dot(n) > 1 - 1e-9 and abs((c - f.CenterOfMass).dot(fn)) < tol:
            return True
    return False


@pytest.fixture
def docs():
    yield
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)
    session.set_decals([])


def test_decal_on_top_face_and_through_assemblies(tmp_path, docs):
    lid = tmp_path / "lid.FCStd"
    _save_lid(lid)
    art = tmp_path / "art"
    art.mkdir()
    img = art / "label.png"
    _png(str(img), 200, 100)
    assert decals.image_size(str(img)) == (200, 100)

    # ---- (a) the part itself --------------------------------------------
    methods.document_open(str(lid))
    d = session.doc(create=False)
    body = d.getObject("Body")
    top = "Face%d" % (_face_index(body, BODY_PL.Rotation.multVec(Vector(0, 0, 1))) + 1)

    r = decals.decal_add("Body", top, str(img), 30)
    rec = r["decal"]
    assert rec["heightMm"] == pytest.approx(15.0)  # from the 2:1 image
    assert rec["missing"] is False and rec["resolvedFace"] == top

    dec = _mesh(methods.scene_get(), "Body")["decals"]
    assert len(dec) == 1
    # box-local top centre (20, 10, 5) through the body placement
    want_c = BODY_PL.multVec(Vector(20, 10, 5))
    assert _close(dec[0]["center"], list(want_c))
    assert _close(dec[0]["normal"], [0, 0, 1])
    assert _close(dec[0]["u"], list(BODY_PL.Rotation.multVec(Vector(1, 0, 0))))
    assert dec[0]["width"] == pytest.approx(30) and dec[0]["height"] == pytest.approx(15)
    assert dec[0]["image"] == str(img)

    # offset + rotation, in the face's (u, v) axes
    decals.decal_update(rec["id"], offsetMm=[5, 2], rotationDeg=90)
    dec = _mesh(methods.scene_get(), "Body")["decals"][0]
    assert _close(dec["center"], list(BODY_PL.multVec(Vector(25, 12, 5))))
    assert _close(dec["u"], list(BODY_PL.Rotation.multVec(Vector(0, 1, 0))))
    local_c = Vector(25, 12, 5)
    local_u = Vector(0, 1, 0)

    # non-planar faces are refused
    cyl = d.getObject("Round")
    side = next(i for i, f in enumerate(cyl.Shape.Faces) if not decals._is_planar(f))
    with pytest.raises(RpcError):
        decals.decal_add("Round", "Face%d" % (side + 1), str(img), 10)

    # the companion stores the image relative to its folder
    methods.document_save()
    comp = json.load(open(str(lid) + ".gwtcad.json"))
    assert [c["image"] for c in comp["decals"]] == [os.path.join("art", "label.png")]
    assert comp["decals"][0]["face"] == top

    # a stale FaceN is re-found by the stored normal + centroid
    comp["decals"][0]["face"] = "Face1" if top != "Face1" else "Face2"
    json.dump(comp, open(str(lid) + ".gwtcad.json", "w"))
    methods.document_open(str(lid))
    lst = decals.decal_list()["decals"]
    assert lst[0]["image"] == str(img) and lst[0]["resolvedFace"] == top
    dec = _mesh(methods.scene_get(), "Body")["decals"][0]
    assert _close(dec["center"], list(BODY_PL.multVec(local_c)))
    comp["decals"][0]["face"] = top
    json.dump(comp, open(str(lid) + ".gwtcad.json", "w"))

    # ---- (b) linked into an assembly, translated + rotated ----------------
    methods.session_reset()
    a = session.doc()
    a.saveAs(str(tmp_path / "asm.FCStd"))
    link = _assembly.add_component(a, str(lid))
    link_pl = Placement(Vector(100, -30, 7), Rotation(Vector(1, 1, 0), 60))
    _assembly.set_placement(a, link.Name, list(link_pl.Base),
                            list(link_pl.Rotation.Axis), math.degrees(link_pl.Rotation.Angle))
    scene = methods.scene_get()
    ldec = _mesh(scene, link.Name)["decals"]
    assert len(ldec) == 1
    # an App::Link replaces the body placement with its own
    assert _close(ldec[0]["center"], list(link_pl.multVec(local_c)))
    assert _close(ldec[0]["normal"], list(link_pl.Rotation.multVec(Vector(0, 0, 1))))
    assert _close(ldec[0]["u"], list(link_pl.Rotation.multVec(local_u)))
    assert ldec[0]["image"] == str(img)
    assert _on_face(link.Shape, ldec[0])
    a.save()
    asm_path = a.FileName

    # ---- (b') one level deeper: that assembly as a sub-assembly -----------
    methods.session_reset()
    t = session.doc()
    t.saveAs(str(tmp_path / "top.FCStd"))
    sub = _assembly.add_component(t, asm_path)
    assert sub.LinkedObject.TypeId == "Assembly::AssemblyObject"
    sub_pl = Placement(Vector(-5, 40, 0), Rotation(Vector(0, 0, 1), 45))
    _assembly.set_placement(t, sub.Name, list(sub_pl.Base),
                            list(sub_pl.Rotation.Axis), math.degrees(sub_pl.Rotation.Angle))
    sdec = _mesh(methods.scene_get(), sub.Name)["decals"]
    assert len(sdec) == 1
    full = sub_pl.multiply(link_pl)
    assert _close(sdec[0]["center"], list(full.multVec(local_c)))
    assert _close(sdec[0]["normal"], list(full.Rotation.multVec(Vector(0, 0, 1))))
    assert _close(sdec[0]["u"], list(full.Rotation.multVec(local_u)))
    assert _on_face(sub.Shape, sdec[0])

    # decals are refused on a component (they belong in its part file)
    with pytest.raises(RpcError):
        decals.decal_add(sub.Name, "Face1", str(img), 10)
