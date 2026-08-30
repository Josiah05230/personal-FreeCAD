"""Tiny JSON-RPC 2.0 method registry and dispatcher.

Methods register with @method("namespace.name"). Dispatch is synchronous and
single-threaded on purpose: FreeCAD / OCCT document mutation is not thread-safe,
so the HTTP server processes one request at a time.
"""
import traceback

METHODS = {}


def method(name):
    def deco(fn):
        if name in METHODS:
            raise RuntimeError("duplicate RPC method: %s" % name)
        METHODS[name] = fn
        return fn
    return deco


# JSON-RPC 2.0 error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
APP_ERROR = -32000


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _error(code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return err


# Methods that never mutate the FreeCAD document, or manage their own doc
# lifecycle - these run outside an undo transaction.
_NO_TXN = {
    "ping", "scene.get", "tree.get", "measure.compute", "params.list",
    "expr.eval", "feature.primaryDim", "feature.exprs", "drawing.list",
    "drawing.addView", "document.info", "assembly.tree",
    "session.reset", "document.open", "document.save", "document.saveAs",
    "history.undo", "history.redo",
    "io.export", "io.exportStep", "io.exportStl",
    "object.setVisibility", "visibility.setGroup",
    "datum.planePreview",
}


def _open_txn(name):
    if name in _NO_TXN:
        return None
    try:
        from gwtcad import session
        d = session.doc(create=False)
        if d is None:
            return None
        d.openTransaction(name)
        return d
    except Exception:
        return None


def dispatch(payload):
    """Handle one parsed JSON-RPC request object. Returns a response dict.

    Notifications (no `id`) still return a dict here; the caller decides whether
    to write it back.
    """
    rpc_id = payload.get("id") if isinstance(payload, dict) else None

    if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(INVALID_REQUEST, "expected JSON-RPC 2.0 object")}

    name = payload.get("method")
    params = payload.get("params", {})
    if not isinstance(name, str):
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(INVALID_REQUEST, "missing method name")}

    fn = METHODS.get(name)
    if fn is None:
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(METHOD_NOT_FOUND, "no such method: %s" % name)}

    txn = _open_txn(name)
    try:
        if isinstance(params, dict):
            result = fn(**params)
        elif isinstance(params, list):
            result = fn(*params)
        else:
            result = fn(params)
        if txn is not None:
            try:
                txn.commitTransaction()
            except Exception:
                pass
        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}
    except RpcError as e:
        _abort(txn)
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(e.code, e.message, e.data)}
    except TypeError as e:
        # most commonly a bad params signature
        _abort(txn)
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(INVALID_PARAMS, str(e))}
    except Exception as e:  # noqa: BLE001 - sidecar must never crash on a bad call
        _abort(txn)
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": _error(APP_ERROR, "%s: %s" % (type(e).__name__, e),
                                {"traceback": traceback.format_exc()})}


def _abort(txn):
    if txn is None:
        return
    try:
        txn.abortTransaction()
    except Exception:
        pass
