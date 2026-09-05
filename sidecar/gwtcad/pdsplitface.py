"""A real, native, editable PartDesign Split Face feature.

Same PartDesign::FeaturePython approach as pdscale.py: body.newObject() wires
up BaseFeature and advances body.Tip exactly like a native Pad/Fillet, and a
Proxy with execute(obj) makes it genuinely parametric. Split Face imprints a
plane's intersection onto BaseFeature.Shape (splitting faces without changing
volume) via Part.Shape.generalFuse - it does not remove or add material, so
there is no PartDesign primitive for it and this is the only way to get one.

The splitting reference is kept LIVE as an App::PropertyLinkSub to whatever it
was picked from (an edge/face's owning object, a datum, or an origin plane
feature) so upstream changes (the referenced body moving, a datum's offset
changing) re-drive the split on recompute - not just a frozen snapshot. Per
_resolve_ref's convention, that owning object is a Tip-chain sibling within
the SAME body (never the Body container itself - PartDesign forbids a feature
referencing its own body, see methods.py's _resolve_ref docstring), so linking
to it here is the same safe pattern every other dress-up feature already uses.
"""
import FreeCAD as App
import Part


class SplitFaceProxy:
    def __init__(self, obj):
        if "PlaneSupport" not in obj.PropertiesList:
            obj.addProperty("App::PropertyLinkSub", "PlaneSupport", "SplitFace",
                            "The face / datum / origin plane this split is imprinted from")
        if "PlaneBase" not in obj.PropertiesList:
            obj.addProperty("App::PropertyVector", "PlaneBase", "SplitFace",
                            "Fallback plane point if PlaneSupport cannot be resolved").PlaneBase = App.Vector(0, 0, 0)
        if "PlaneNormal" not in obj.PropertiesList:
            obj.addProperty("App::PropertyVector", "PlaneNormal", "SplitFace",
                            "Fallback plane normal if PlaneSupport cannot be resolved").PlaneNormal = App.Vector(0, 0, 1)
        obj.Proxy = self

    def _plane(self, obj):
        sup = getattr(obj, "PlaneSupport", None)
        src = sup[0] if sup else None
        if src is not None:
            subs = sup[1] if len(sup) > 1 else []
            sub0 = subs[0] if subs else ""
            if sub0.startswith("Face") and hasattr(src, "Shape"):
                try:
                    f = src.Shape.getElement(sub0)
                    return f.CenterOfMass, f.normalAt(0.5, 0.5)
                except Exception:
                    pass
            try:
                p = src.Placement
                return p.Base, p.Rotation.multVec(App.Vector(0, 0, 1))
            except Exception:
                pass
        return obj.PlaneBase, obj.PlaneNormal

    def execute(self, obj):
        base = getattr(obj, "BaseFeature", None)
        if base is None:
            return
        shp = getattr(base, "Shape", None)
        if shp is None or shp.isNull():
            return
        pt, n = self._plane(obj)
        if n.Length < 1e-9:
            return
        bb = shp.BoundBox
        size = (bb.DiagonalLength * 2.0) or 100.0
        plane = Part.makePlane(size, size, App.Vector(0, 0, 0), n)
        plane.translate(pt - plane.CenterOfMass)
        try:
            compound = shp.copy().generalFuse([plane])[0]
        except Exception:
            return
        # generalFuse returns every piece from BOTH inputs, including the
        # splitting plane's own leftover slice outside the solid - keep only
        # the solid(s) that came from the base shape, not the planar tool
        solids = compound.Solids if compound is not None else []
        if not solids:
            return
        result = solids[0] if len(solids) == 1 else Part.makeCompound(solids)
        if result is None or result.isNull():
            return
        obj.Shape = result


def add_split_face_feature(body, plane_support, plane_base, plane_normal, name="SplitFace"):
    """plane_support: (obj, [sub]) or None. plane_base/plane_normal: Vector
    fallbacks (also the values used if plane_support is None - a frozen
    plane with no live reference to re-derive from)."""
    from .vocab import next_label
    obj = body.newObject("PartDesign::FeaturePython", name)
    obj.Label = next_label(body, "PartDesign::FeaturePython")
    SplitFaceProxy(obj)
    if plane_support is not None:
        obj.PlaneSupport = plane_support
    obj.PlaneBase = App.Vector(*plane_base)
    obj.PlaneNormal = App.Vector(*plane_normal)
    return obj
