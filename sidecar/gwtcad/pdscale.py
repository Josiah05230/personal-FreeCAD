"""A real, native, editable PartDesign Scale feature.

FreeCAD's PartDesign workbench has no built-in Scale feature type, but it does
support scripted ones: PartDesign::FeaturePython behaves exactly like a native
Pad/Fillet/etc in the body's timeline (body.newObject() wires up BaseFeature
and advances body.Tip automatically) as long as something sets its `.Proxy` to
a Python object with an `execute(obj)` method. That makes this a genuine
parametric feature - editable, re-computes on a parameter or upstream change,
and (verified) survives a real close + reopen of the .FCStd with its Proxy
correctly restored, AS LONG AS this module is importable, i.e. the file is
being opened by GWT-CAD's own sidecar (or anything else with gwtcad on
sys.path) - plain FreeCAD with no such module available falls back to just
showing the last-computed static Shape (FreeCAD's normal behaviour for any
scripted object whose Python module cannot be found), not a crash.
"""
import FreeCAD as App


class ScaleProxy:
    """obj.BaseFeature.Shape, scaled about obj.Center by obj.Factor (uniform)
    or obj.ScaleX/Y/Z (non-uniform), per obj.Uniform."""

    def __init__(self, obj):
        if "Uniform" not in obj.PropertiesList:
            obj.addProperty("App::PropertyBool", "Uniform", "Scale",
                            "Same factor on all three axes").Uniform = True
        if "Factor" not in obj.PropertiesList:
            obj.addProperty("App::PropertyFloat", "Factor", "Scale",
                            "Scale factor when Uniform is set").Factor = 1.0
        if "ScaleX" not in obj.PropertiesList:
            obj.addProperty("App::PropertyFloat", "ScaleX", "Scale",
                            "X scale factor when Uniform is not set").ScaleX = 1.0
        if "ScaleY" not in obj.PropertiesList:
            obj.addProperty("App::PropertyFloat", "ScaleY", "Scale", "").ScaleY = 1.0
        if "ScaleZ" not in obj.PropertiesList:
            obj.addProperty("App::PropertyFloat", "ScaleZ", "Scale", "").ScaleZ = 1.0
        if "Center" not in obj.PropertiesList:
            obj.addProperty("App::PropertyVector", "Center", "Scale",
                            "Scale centre, world coordinates").Center = App.Vector(0, 0, 0)
        obj.Proxy = self

    def execute(self, obj):
        base = getattr(obj, "BaseFeature", None)
        if base is None:
            return
        shp = getattr(base, "Shape", None)
        if shp is None or shp.isNull():
            return
        if obj.Uniform:
            sx = sy = sz = float(obj.Factor) or 1.0
        else:
            sx, sy, sz = float(obj.ScaleX) or 1.0, float(obj.ScaleY) or 1.0, float(obj.ScaleZ) or 1.0
        c = obj.Center
        mat = App.Matrix()
        mat.move(App.Vector(-c.x, -c.y, -c.z))
        mat.scale(sx, sy, sz)
        mat.move(c)
        obj.Shape = shp.copy().transformGeometry(mat)


def add_scale_feature(body, uniform, factor, sx, sy, sz, center, name="Scale"):
    """Create (or, given an existing one, reconfigure) a Scale feature at the
    tip of `body`. Returns the feature object."""
    from .vocab import next_label
    obj = body.newObject("PartDesign::FeaturePython", name)
    obj.Label = next_label(body, "PartDesign::FeaturePython")
    ScaleProxy(obj)
    obj.Uniform = bool(uniform)
    obj.Factor = float(factor)
    obj.ScaleX, obj.ScaleY, obj.ScaleZ = float(sx), float(sy), float(sz)
    obj.Center = App.Vector(*center)
    return obj


def update_scale_feature(obj, uniform=None, factor=None, sx=None, sy=None, sz=None, center=None):
    """Re-apply new parameters to an existing Scale feature (feature.update)."""
    if not hasattr(obj, "Proxy") or obj.Proxy is None:
        ScaleProxy(obj)  # a reopened doc that could not restore Proxy - reattach
    if uniform is not None:
        obj.Uniform = bool(uniform)
    if factor is not None:
        obj.Factor = float(factor)
    if sx is not None:
        obj.ScaleX = float(sx)
    if sy is not None:
        obj.ScaleY = float(sy)
    if sz is not None:
        obj.ScaleZ = float(sz)
    if center is not None:
        obj.Center = App.Vector(*center)
    obj.touch()
