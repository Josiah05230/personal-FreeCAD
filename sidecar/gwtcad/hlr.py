"""Skip TechDraw's 2D face search while a view computes.

After hidden-line removal TechDraw walks the projected edges looking for
closed faces (for hatching / face picks in its own GUI). GWT-CAD draws only
the edges, and that search is most of a view's cost on an assembly - ten
connector models: 26s with it, under 10s without, identical edges.

It is switched by a FreeCAD user preference (Mod/TechDraw/General
HandleFaces), which is read at compute time and SAVED to the shared
user.cfg when the process exits - too early for an atexit hook to put it
back. So it is only ever off inside `no_face_search()` and restored the
moment the block ends: plain FreeCAD keeps its own setting.
"""
import contextlib

_depth = [0]
_saved = [True]


def _group():
    import FreeCAD as App
    return App.ParamGet("User parameter:BaseApp/Preferences/Mod/TechDraw/General")


@contextlib.contextmanager
def no_face_search():
    try:
        g = _group()
    except Exception:  # no FreeCAD (plain pytest): nothing to switch
        yield
        return
    if _depth[0] == 0:
        _saved[0] = g.GetBool("HandleFaces", True)
        g.SetBool("HandleFaces", False)
    _depth[0] += 1
    try:
        yield
    finally:
        _depth[0] -= 1
        if _depth[0] == 0:
            g.SetBool("HandleFaces", _saved[0])


def recompute(obj, *args):
    """obj.recompute(...) with the face search off (a document or one object)."""
    with no_face_search():
        return obj.recompute(*args)
