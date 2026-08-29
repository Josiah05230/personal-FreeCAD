"""FreeCAD internal names -> the vocabulary the UI shows.

The user never sees "Pad", "Pocket", "Groove", etc. Feature labels are set from
this map at creation time, and `tree.get` also reports a clean `opType` so the
timeline/browser never leak FreeCAD terminology.
"""

# TypeId -> display operation name
OP_NAME = {
    "PartDesign::Pad": "Extrude",
    "PartDesign::Pocket": "Extrude",          # cut extrude, same tool in Fusion
    "PartDesign::Revolution": "Revolve",
    "PartDesign::Groove": "Revolve",
    "PartDesign::AdditivePipe": "Sweep",
    "PartDesign::SubtractivePipe": "Sweep",
    "PartDesign::AdditiveLoft": "Loft",
    "PartDesign::SubtractiveLoft": "Loft",
    "PartDesign::Hole": "Hole",
    "PartDesign::Fillet": "Fillet",
    "PartDesign::Chamfer": "Chamfer",
    "PartDesign::Thickness": "Shell",
    "PartDesign::Draft": "Draft",
    "PartDesign::Mirrored": "Mirror",
    "PartDesign::LinearPattern": "Rectangular Pattern",
    "PartDesign::PolarPattern": "Circular Pattern",
    "PartDesign::Boolean": "Combine",
    "Sketcher::SketchObject": "Sketch",
    "PartDesign::Plane": "Construction Plane",
    "PartDesign::Line": "Construction Axis",
    "PartDesign::Point": "Construction Point",
    "PartDesign::CoordinateSystem": "Construction System",
}


def op_name(type_id):
    return OP_NAME.get(type_id, type_id.split("::")[-1])


def next_label(body, type_id):
    """A Fusion-style unique label, e.g. 'Extrude1', 'Sketch3'."""
    base = op_name(type_id).replace(" ", "")
    existing = {getattr(f, "Label", "") for f in getattr(body, "Group", [])}
    i = 1
    while "%s%d" % (base, i) in existing:
        i += 1
    return "%s%d" % (base, i)
