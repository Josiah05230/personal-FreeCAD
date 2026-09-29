"""Face decals: an image applied at true scale onto a planar face of a part.

The use case is product labels - PNG artwork at an exact mm size shown on an
enclosure lid. A decal is pure view state (three.js draws it as a textured
quad), persisted in the part's .gwtcad companion under "decals":

    {"id": "Decal1", "object": "Body", "face": "Face6",
     "image": "labels/lid.png",          # relative to the companion's folder
     "widthMm": 40.0, "heightMm": 20.0,
     "offsetMm": [0.0, 0.0],             # decal centre from the face centroid,
                                         # along the face's (u, v) axes
     "rotationDeg": 0.0,                 # about the face normal, CCW seen
                                         # from outside
     "faceNormal": [0, 0, 1],            # object-local (Placement undone), so
     "faceCentroid": [20, 10, 5]}        # the face can be re-found by geometry
                                         # if FaceN renumbers after a recompute

In the live session the image path is kept absolute (session.decals); it is
made relative to the companion's folder only when written to disk, so a
Save As into another folder still resolves.

Face axes: v points "up" (the object's local +Z projected into the face)
where that is defined, u = v x n; a face whose normal is +-Z uses u = +X. So
u, v, n is right-handed and an image on a side wall reads upright.

Scene: scene_decals(o) gives each decal's frame (centre, normal, u, size) in
the frame of o.Shape - the frame the tessellated mesh is in. For an App::Link
the linked object's decals are mapped by the link's shape placement, and an
assembly passes its children's decals through its own placement, recursively,
the same walk appearance.inherited_face_colors does for colours.
"""
import math
import os
import struct

import FreeCAD as App
import Part
from FreeCAD import Vector

from .registry import method, RpcError, APP_ERROR
from . import session

IMAGE_EXTS = (".png", ".jpg", ".jpeg")
_SKIP_CHILD_TYPES = ("Assembly::JointGroup", "App::Origin", "App::DocumentObjectGroup")
_CONTAINER_TYPES = ("Assembly::AssemblyObject", "App::Part")


# --------------------------------------------------------------------------- #
# image size (PNG / JPEG headers - no imaging library in the bundled Python)
# --------------------------------------------------------------------------- #

def image_size(path):
    """(width_px, height_px) or None."""
    try:
        with open(path, "rb") as f:
            head = f.read(26)
            if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                return struct.unpack(">II", head[16:24])
            if head[:2] != b"\xff\xd8":
                return None
            f.seek(2)
            while True:
                b = f.read(1)
                while b and b != b"\xff":
                    b = f.read(1)
                while b == b"\xff":
                    b = f.read(1)
                if not b:
                    return None
                marker = b[0]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    continue
                ln = f.read(2)
                if len(ln) < 2:
                    return None
                seg = struct.unpack(">H", ln)[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    data = f.read(5)
                    h, w = struct.unpack(">HH", data[1:5])
                    return (w, h)
                f.seek(seg - 2, 1)
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# geometry helpers
# --------------------------------------------------------------------------- #

def _v(x):
    return Vector(float(x[0]), float(x[1]), float(x[2]))


def _l(v):
    return [float(v.x), float(v.y), float(v.z)]


def _is_planar(face):
    try:
        if isinstance(face.Surface, Part.Plane):
            return True
        return face.findPlane() is not None
    except Exception:
        return False


def _face_normal(face):
    u0, u1, v0, v1 = face.ParameterRange
    n = face.normalAt((u0 + u1) / 2.0, (v0 + v1) / 2.0)
    return n.normalize() if n.Length > 1e-12 else n


def _face_local(o, face):
    """(centroid, normal) of a face, object-local (the shape's Placement undone)."""
    inv = o.Shape.Placement.inverse()
    return inv.multVec(face.CenterOfMass), inv.Rotation.multVec(_face_normal(face)).normalize()


def face_axes(n):
    """In-plane (u, v) for a unit normal n: v = local +Z projected, u = v x n."""
    z = Vector(0, 0, 1)
    if abs(n.dot(z)) > 0.999:
        u = Vector(1, 0, 0)
        u = (u - n * u.dot(n)).normalize()
    else:
        v = (z - n * z.dot(n)).normalize()
        u = v.cross(n).normalize()
    v = n.cross(u).normalize()
    return u, v


def _resolve_face(o, rec):
    """(index, face) for a decal's face: its FaceN when that still is the same
    plane, else the planar face with the same normal nearest the stored
    centroid. None when nothing matches (the decal is shown as missing)."""
    sh = getattr(o, "Shape", None)
    if sh is None or sh.isNull():
        return None
    faces = sh.Faces
    n0 = _v(rec.get("faceNormal") or (0, 0, 0))
    c0 = _v(rec.get("faceCentroid") or (0, 0, 0))
    have_geo = n0.Length > 1e-9

    def same_plane(f):
        if not _is_planar(f):
            return False
        c, n = _face_local(o, f)
        return n.dot(n0) > 0.9999 and abs((c - c0).dot(n0)) < 1e-3

    try:
        i = int(str(rec.get("face", "")).replace("Face", "")) - 1
    except ValueError:
        i = -1
    if 0 <= i < len(faces) and _is_planar(faces[i]):
        if not have_geo or same_plane(faces[i]):
            return i, faces[i]
    if not have_geo:
        return None
    best = None
    for j, f in enumerate(faces):
        if not _is_planar(f):
            continue
        c, n = _face_local(o, f)
        if n.dot(n0) <= 0.9999:
            continue
        # prefer the same plane, then the nearest centroid
        key = (0 if abs((c - c0).dot(n0)) < 1e-3 else 1, (c - c0).Length)
        if best is None or key < best[0]:
            best = (key, j, f)
    return (best[1], best[2]) if best else None


def _frame(o, rec):
    """The decal's frame in o.Shape's frame, or None if its face is gone."""
    hit = _resolve_face(o, rec)
    if hit is None:
        return None
    _, face = hit
    c, n = _face_local(o, face)
    u0, v0 = face_axes(n)
    off = rec.get("offsetMm") or [0.0, 0.0]
    centre = c + u0 * float(off[0]) + v0 * float(off[1])
    a = math.radians(float(rec.get("rotationDeg") or 0.0))
    u = u0 * math.cos(a) + v0 * math.sin(a)
    pl = o.Shape.Placement
    return {
        "center": pl.multVec(centre),
        "normal": pl.Rotation.multVec(n),
        "u": pl.Rotation.multVec(u),
    }


def _xf(fr, pl):
    return {"center": pl.multVec(fr["center"]),
            "normal": pl.Rotation.multVec(fr["normal"]),
            "u": pl.Rotation.multVec(fr["u"])}


# --------------------------------------------------------------------------- #
# records: live session vs another document's companion
# --------------------------------------------------------------------------- #

def _abs_image(img, base):
    if not img:
        return img
    if os.path.isabs(img) or not base:
        return img
    return os.path.normpath(os.path.join(base, img))


def to_disk(records, base):
    """Session records (absolute image paths) -> companion records."""
    out = []
    for r in records or []:
        r = dict(r)
        img = r.get("image")
        if img and base and os.path.isabs(img):
            try:
                r["image"] = os.path.relpath(img, base)
            except ValueError:
                pass  # another drive (Windows) - keep it absolute
        out.append(r)
    return out


def from_disk(records, base):
    """Companion records -> absolute image paths."""
    out = []
    for r in records or []:
        if not isinstance(r, dict) or not r.get("id"):
            continue
        r = dict(r)
        r["image"] = _abs_image(r.get("image"), base)
        out.append(r)
    return out


def _records_for(o):
    """Decal records (absolute image paths) on object o, from the live
    session if o lives in the open document, else from its file's companion."""
    sd = session.doc(create=False)
    if sd is not None and o.Document is sd:
        recs = session.decals()
    else:
        from . import appearance as _appearance
        comp = _appearance._companion_of(o.Document)
        base = os.path.dirname(getattr(o.Document, "FileName", "") or "")
        recs = from_disk(comp.get("decals"), base)
    return [r for r in recs if r.get("object") == o.Name]


def _own(o):
    out = []
    for r in _records_for(o):
        try:
            fr = _frame(o, r)
        except Exception:
            fr = None
        if fr is None:
            continue
        fr["rec"] = r
        out.append(fr)
    return out


def _decal_frames(o, depth=0):
    sh = getattr(o, "Shape", None)
    if sh is None or sh.isNull() or depth > 12:
        return []
    out = []
    try:
        if o.TypeId == "App::Link":
            t = getattr(o, "LinkedObject", None)
            tsh = getattr(t, "Shape", None) if t is not None else None
            if t is not None and t is not o and tsh is not None and not tsh.isNull():
                M = sh.Placement.multiply(tsh.Placement.inverse())
                for fr in _decal_frames(t, depth + 1):
                    out.append(dict(_xf(fr, M), rec=fr["rec"]))
        elif o.TypeId in _CONTAINER_TYPES:
            M = sh.Placement
            for c in getattr(o, "Group", []) or []:
                if c.TypeId in _SKIP_CHILD_TYPES:
                    continue
                for fr in _decal_frames(c, depth + 1):
                    out.append(dict(_xf(fr, M), rec=fr["rec"]))
    except Exception:
        pass
    out.extend(_own(o))
    return out


def scene_decals(o):
    """Render DTOs for every decal shown on o's mesh (its own + inherited
    through links / sub-assemblies), in o.Shape's frame."""
    out = []
    for i, fr in enumerate(_decal_frames(o)):
        r = fr["rec"]
        img = r.get("image") or ""
        try:
            mtime = os.path.getmtime(img)
        except OSError:
            mtime = None
        out.append({
            "id": r.get("id") if o.TypeId != "App::Link" else "%s:%d" % (r.get("id"), i),
            "center": _l(fr["center"]),
            "normal": _l(fr["normal"]),
            "u": _l(fr["u"]),
            "width": float(r.get("widthMm") or 0.0),
            "height": float(r.get("heightMm") or 0.0),
            "image": img,
            "imageMtime": mtime,
        })
    return out


# --------------------------------------------------------------------------- #
# RPCs
# --------------------------------------------------------------------------- #

def _doc():
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    return d


def _target(d, name):
    o = d.getObject(name) if name else None
    if o is None:
        raise RpcError(APP_ERROR, "no object %r" % name)
    if o.TypeId == "App::Link" or o.TypeId in _CONTAINER_TYPES:
        raise RpcError(APP_ERROR, "%s is an assembly component - open its part "
                       "file to put a decal on it" % o.Label)
    sh = getattr(o, "Shape", None)
    if sh is None or sh.isNull():
        raise RpcError(APP_ERROR, "%s has no shape" % o.Label)
    return o


def _check_image(image):
    if not image:
        raise RpcError(APP_ERROR, "no image given")
    p = os.path.abspath(os.path.expanduser(str(image)))
    if not os.path.isfile(p):
        raise RpcError(APP_ERROR, "no such image: %s" % p)
    if os.path.splitext(p)[1].lower() not in IMAGE_EXTS:
        raise RpcError(APP_ERROR, "a decal image must be PNG or JPG")
    return p


def _face_geo(o, face_name):
    try:
        i = int(str(face_name).replace("Face", "")) - 1
    except ValueError:
        raise RpcError(APP_ERROR, "not a face: %r" % face_name)
    faces = o.Shape.Faces
    if not 0 <= i < len(faces):
        raise RpcError(APP_ERROR, "%s has no %s" % (o.Label, face_name))
    f = faces[i]
    if not _is_planar(f):
        raise RpcError(APP_ERROR, "%s is not flat - a decal needs a planar face" % face_name)
    c, n = _face_local(o, f)
    return {"face": "Face%d" % (i + 1), "faceNormal": _l(n), "faceCentroid": _l(c)}


def _size(image, width, height):
    w = float(width)
    if not w > 0:
        raise RpcError(APP_ERROR, "decal width must be > 0")
    if height is not None and float(height) > 0:
        return w, float(height)
    px = image_size(image)
    if px and px[0] > 0:
        return w, w * float(px[1]) / float(px[0])
    return w, w


def _public(r, d=None):
    """A session record for the client: plus `missing` if its face is gone."""
    out = dict(r)
    d = d or session.doc(create=False)
    o = d.getObject(r.get("object") or "") if d is not None else None
    hit = None
    if o is not None:
        try:
            hit = _resolve_face(o, r)
        except Exception:
            hit = None
    out["missing"] = hit is None
    if hit is not None:
        out["resolvedFace"] = "Face%d" % (hit[0] + 1)
    out["imageName"] = os.path.basename(r.get("image") or "")
    return out


def _next_id(recs):
    n = 0
    for r in recs:
        try:
            n = max(n, int(str(r.get("id", "")).replace("Decal", "")))
        except ValueError:
            pass
    return "Decal%d" % (n + 1)


@method("decal.list")
def decal_list():
    d = session.doc(create=False)
    return {"decals": [_public(r, d) for r in session.decals()]}


@method("decal.add")
def decal_add(object, face, image, widthMm, heightMm=None, offsetMm=None, rotationDeg=0.0):
    """Put `image` (PNG/JPG) on planar `face` of `object` at widthMm wide;
    heightMm defaults from the image's aspect ratio."""
    d = _doc()
    o = _target(d, object)
    img = _check_image(image)
    geo = _face_geo(o, face)
    w, h = _size(img, widthMm, heightMm)
    recs = session.decals()
    off = list(offsetMm) if offsetMm else [0.0, 0.0]
    rec = {"id": _next_id(recs), "object": o.Name, "image": img,
           "widthMm": w, "heightMm": h,
           "offsetMm": [float(off[0]), float(off[1])],
           "rotationDeg": float(rotationDeg or 0.0)}
    rec.update(geo)
    recs.append(rec)
    session.set_decals(recs)
    return {"decal": _public(rec, d), "decals": [_public(r, d) for r in recs]}


@method("decal.update")
def decal_update(id, image=None, widthMm=None, heightMm=None, offsetMm=None,
                 rotationDeg=None, object=None, face=None, keepAspect=False):
    """Change any of a decal's fields. `object`+`face` re-seat it on another
    face. `keepAspect` with only widthMm re-derives the height from the image."""
    d = _doc()
    recs = session.decals()
    rec = next((r for r in recs if r.get("id") == id), None)
    if rec is None:
        raise RpcError(APP_ERROR, "no decal %r" % id)
    if image is not None:
        rec["image"] = _check_image(image)
    if face is not None or object is not None:
        o = _target(d, object or rec.get("object"))
        rec["object"] = o.Name
        rec.update(_face_geo(o, face or rec.get("face")))
    if widthMm is not None:
        w = float(widthMm)
        if not w > 0:
            raise RpcError(APP_ERROR, "decal width must be > 0")
        if keepAspect and heightMm is None:
            _, rec["heightMm"] = _size(rec["image"], w, None)
        rec["widthMm"] = w
    if heightMm is not None:
        h = float(heightMm)
        if not h > 0:
            raise RpcError(APP_ERROR, "decal height must be > 0")
        rec["heightMm"] = h
    if offsetMm is not None:
        rec["offsetMm"] = [float(offsetMm[0]), float(offsetMm[1])]
    if rotationDeg is not None:
        rec["rotationDeg"] = float(rotationDeg)
    session.set_decals(recs)
    return {"decal": _public(rec, d), "decals": [_public(r, d) for r in recs]}


@method("decal.remove")
def decal_remove(id):
    recs = session.decals()
    keep = [r for r in recs if r.get("id") != id]
    if len(keep) == len(recs):
        raise RpcError(APP_ERROR, "no decal %r" % id)
    session.set_decals(keep)
    d = session.doc(create=False)
    return {"removed": id, "decals": [_public(r, d) for r in keep]}
