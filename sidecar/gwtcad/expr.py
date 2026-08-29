"""Tiny unit-aware expression evaluator for dimension inputs.

Accepts things like `15in + 2.4mm`, `width/2`, `hole_d * 3`, `sqrt(2)*10`.
Lengths normalise to millimetres, angles to degrees. Bare parameter names are
resolved (recursively) from a {name: expr} map.
"""
import ast
import math
import operator
import re

_UNITS_MM = {
    "mm": 1.0, "cm": 10.0, "m": 1000.0,
    "in": 25.4, '"': 25.4, "ft": 304.8, "'": 304.8,
    "thou": 0.0254, "mil": 0.0254, "um": 0.001,
}
_UNITS_DEG = {"deg": 1.0, "°": 1.0, "rad": 180.0 / math.pi}

_NUM_UNIT = re.compile(
    r'(?<![\w.])(\d+(?:\.\d+)?)\s*(mm|cm|m|um|in|ft|thou|mil|deg|rad|°|"|\')'
)

_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
}
_FUNCS = {
    "sqrt": math.sqrt, "abs": abs, "min": min, "max": max,
    "sin": lambda d: math.sin(math.radians(d)),
    "cos": lambda d: math.cos(math.radians(d)),
    "tan": lambda d: math.tan(math.radians(d)),
    "floor": math.floor, "ceil": math.ceil,
}


def _preprocess(text, kind):
    table = _UNITS_MM if kind == "length" else _UNITS_DEG

    def sub(m):
        return repr(float(m.group(1)) * table.get(m.group(2), 1.0))

    return _NUM_UNIT.sub(sub, text)


def evaluate(text, kind="length", params=None, _seen=None):
    """Return a float: millimetres for kind='length', degrees for kind='angle'."""
    params = params or {}
    _seen = _seen or set()
    src = _preprocess(str(text).strip(), kind)
    if not src:
        raise ValueError("empty expression")
    tree = ast.parse(src, mode="eval")

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
            return _BINOPS[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp):
            v = ev(node.operand)
            return -v if isinstance(node.op, ast.USub) else +v
        if isinstance(node, ast.Name):
            n = node.id
            if n in _seen:
                raise ValueError("parameter cycle at %r" % n)
            if n in params:
                return evaluate(params[n], kind, params, _seen | {n})
            raise ValueError("unknown name %r" % n)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            fn = _FUNCS.get(node.func.id)
            if fn is None:
                raise ValueError("unknown function %r" % node.func.id)
            return float(fn(*[ev(a) for a in node.args]))
        raise ValueError("unsupported expression")

    return float(ev(tree))
