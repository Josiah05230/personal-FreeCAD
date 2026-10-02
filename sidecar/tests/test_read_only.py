"""Read-only viewing of an old revision: the dispatcher refuses every call
outside its allowlist while a reason is set (registry.set_read_only)."""
from gwtcad import registry


def test_read_only_refuses_edits_and_allows_viewing():
    registry.METHODS["test.edit"] = lambda: "edited"
    registry.METHODS["test.view"] = lambda: "viewed"
    registry._READ_ONLY_OK.add("test.view")
    try:
        registry.set_read_only("PSJ0010 is an old revision")
        r = registry.dispatch({"jsonrpc": "2.0", "id": 1, "method": "test.edit"})
        assert r["error"]["message"] == "PSJ0010 is an old revision"
        assert r["error"]["data"] == {"readOnly": True}
        assert registry.dispatch({"jsonrpc": "2.0", "id": 2, "method": "test.view"})["result"] == "viewed"
        registry.set_read_only(None)
        assert registry.dispatch({"jsonrpc": "2.0", "id": 3, "method": "test.edit"})["result"] == "edited"
    finally:
        registry.set_read_only(None)
        registry.METHODS.pop("test.edit", None)
        registry.METHODS.pop("test.view", None)
        registry._READ_ONLY_OK.discard("test.view")
