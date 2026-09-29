"""Full-quality render meshes kept on disk, so a model is only ever meshed
the first time it's opened - after that (even after an app restart) its
bodies load from here in milliseconds instead of being re-tessellated.

Keyed by the shape signature (element counts + vertex bounds + a checksum of
every vertex, world placement included - methods._shape_sig) plus the
meshing settings: any real geometry change is a different key, and
identical shapes (four copies of one screw) share an entry. Entries are
marshal'd buffers (the same dict scene.get sends), written atomically; the
cache is trimmed to MAX_BYTES, least recently used first.
"""
import hashlib
import marshal
import os
import sys
import threading

from .paths import config_path
from . import tessellate as _tess

MAX_BYTES = 2 * 1024 ** 3
FORMAT = 1
_lock = threading.Lock()
_writes = {"n": 0}


def _dir():
    return config_path("meshcache")


def _key(sig):
    settings = (FORMAT, sys.version_info[:2], _tess.SURFACE_DEFLECTION, _tess.ANGULAR_DEFLECTION,
                _tess.EDGE_DEFLECTION, _tess.TANGENT_ANGLE_DEG)
    return hashlib.sha1(repr((settings, sig)).encode()).hexdigest()


def _path(sig):
    k = _key(sig)
    return os.path.join(_dir(), k[:2], k + ".mesh")


def load(sig):
    """The cached full-quality buffer for this shape signature, or None."""
    if not sig:
        return None
    p = _path(sig)
    try:
        with open(p, "rb") as f:
            buf = marshal.load(f)
    except Exception:
        return None
    if not isinstance(buf, dict) or "indices" not in buf:
        return None
    try:
        os.utime(p)  # recency for the LRU trim
    except OSError:
        pass
    return buf


def save(sig, buf):
    """Store a FULL-quality buffer (never a draft). Best effort."""
    if not sig or not buf or buf.get("draft"):
        return
    keep = {k: buf[k] for k in ("positions", "normals", "indices", "faceGroups", "edges", "vertices", "bbox")
            if k in buf}
    p = _path(sig)
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = "%s.%d.tmp" % (p, os.getpid())
        with open(tmp, "wb") as f:
            marshal.dump(keep, f)
        os.replace(tmp, p)
    except Exception:
        return
    _writes["n"] += 1
    if _writes["n"] % 50 == 1:
        threading.Thread(target=trim, daemon=True).start()


def trim(max_bytes=MAX_BYTES):
    """Drop least-recently-used entries until the cache fits in max_bytes."""
    if not _lock.acquire(blocking=False):
        return
    try:
        files = []
        total = 0
        for root, _dirs, names in os.walk(_dir()):
            for n in names:
                if not n.endswith(".mesh"):
                    continue
                p = os.path.join(root, n)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, p))
                total += st.st_size
        if total <= max_bytes:
            return
        files.sort()
        for _mtime, size, p in files:
            if total <= max_bytes * 0.9:
                break
            try:
                os.remove(p)
                total -= size
            except OSError:
                pass
    finally:
        _lock.release()
