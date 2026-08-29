"""GWT-CAD sidecar entrypoint.

Run by the Electron main process as:

    GWTCAD_HOST=127.0.0.1 GWTCAD_PORT=0 freecadcmd sidecar/server.py

Port/host come from the environment because `freecadcmd` swallows its own CLI
flags; `--pass --port N --host H` after the script path also works as a fallback.
Starts a single-threaded JSON-RPC 2.0 server over loopback HTTP and blocks. On a
successful bind it prints one machine-readable line to stdout:

    GWTCAD_SIDECAR_READY {"host": "127.0.0.1", "port": 51763}

so the parent can discover the ephemeral port. Everything else on stdout/stderr
is logging.
"""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gwtcad.registry import dispatch  # noqa: E402
import gwtcad.methods  # noqa: E402,F401  (import registers the RPC methods)

READY_PREFIX = "GWTCAD_SIDECAR_READY "
MAX_BODY_BYTES = 64 * 1024 * 1024  # generous; mesh payloads for parts are small


def _log(*a):
    print("[sidecar]", *a, file=sys.stderr, flush=True)


class Server(HTTPServer):
    """HTTPServer that exits if it is orphaned (parent process died).

    The Electron supervisor may be SIGKILLed (crash, `timeout`, task manager)
    without a chance to reap us; without this the sidecar leaks.
    """
    _start_ppid = os.getppid()

    def service_actions(self):
        if os.getppid() != self._start_ppid and os.getppid() == 1:
            _log("parent gone (orphaned) - exiting")
            os._exit(0)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body_bytes, content_type="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()
        if body_bytes:
            self.wfile.write(body_bytes)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode("utf-8"))

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, b"")

    def do_GET(self):  # noqa: N802
        if self.path in ("/health", "/"):
            self._json(200, {"ok": True, "methods": sorted(_method_names())})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/rpc":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(400, {"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32600, "message": "bad body length"}})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except ValueError as e:
            self._json(200, {"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32700, "message": "parse error: %s" % e}})
            return

        if isinstance(payload, list):
            responses = [dispatch(p) for p in payload]
            responses = [r for r in responses if r.get("id") is not None]
            self._json(200, responses)
        else:
            self._json(200, dispatch(payload))

    def log_message(self, fmt, *args):  # quieter default logging
        _log(self.address_string(), fmt % args)


def _method_names():
    from gwtcad.registry import METHODS
    return METHODS.keys()


def _resolve_host_port():
    """Environment wins (freecadcmd eats CLI flags); `--pass` args are a fallback."""
    host = os.environ.get("GWTCAD_HOST", "127.0.0.1")
    port = int(os.environ.get("GWTCAD_PORT", "0"))
    argv = sys.argv[1:]
    it = iter(argv)
    for a in it:
        if a in ("--host", "--pass"):
            if a == "--host":
                host = next(it, host)
        elif a == "--port":
            port = int(next(it, port))
        elif a.startswith("--host="):
            host = a.split("=", 1)[1]
        elif a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    return host, port


def main():
    host, port = _resolve_host_port()
    httpd = Server((host, port), Handler)
    bound_host, bound_port = httpd.server_address[0], httpd.server_address[1]

    # the one line the parent process parses
    print(READY_PREFIX + json.dumps({"host": bound_host, "port": bound_port}), flush=True)
    _log("listening on http://%s:%d  (%d methods)" % (bound_host, bound_port, len(list(_method_names()))))

    def _stop(signum, frame):
        _log("signal %d, shutting down" % signum)
        httpd.shutdown()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        httpd.serve_forever(poll_interval=0.25)
    finally:
        httpd.server_close()
        _log("stopped")


main()
