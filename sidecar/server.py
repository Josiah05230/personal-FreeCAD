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
import queue
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gwtcad.registry import dispatch  # noqa: E402
import gwtcad.methods  # noqa: E402,F401  (import registers the RPC methods)

READY_PREFIX = "GWTCAD_SIDECAR_READY "
MAX_BODY_BYTES = 64 * 1024 * 1024  # generous; mesh payloads for parts are small

# Why threaded server + a single engine worker:
# The old single-threaded HTTPServer served one keep-alive connection at a time
# and, between requests on it, blocked in readline() waiting for that socket's
# next request - so a SECOND concurrent request (refreshScene alone fires three)
# could not even be accepted until the first connection went idle and undici's
# ~4s keepAliveTimeout closed it. That was whole seconds of "still loading" for
# work the engine does in <1ms.
# Now: connection threads do only socket I/O + JSON; every dispatch() is handed
# to ONE dedicated worker thread (FreeCAD / OCCT is not thread-safe, so all
# document work must stay on a single thread) and the caller blocks on an Event
# for its result. Requests are still executed strictly one at a time, in arrival
# order, just without the TCP-level head-of-line stall.
_engine_q: "queue.Queue" = queue.Queue()


def _engine_worker():
    while True:
        job = _engine_q.get()
        if job is None:
            return
        payload, deliver = job
        try:
            if isinstance(payload, list):
                out = [dispatch(p) for p in payload]
            else:
                out = dispatch(payload)
        except BaseException as e:  # noqa: BLE001 - the worker must never die
            out = {"jsonrpc": "2.0", "id": None,
                   "error": {"code": -32603, "message": "engine worker error: %s" % e}}
        try:
            deliver(out)
        except Exception:
            pass


def _run_on_engine(payload):
    """Block the calling (connection) thread until the engine worker has a result."""
    box = []
    ev = threading.Event()

    def _deliver(result):
        box.append(result)
        ev.set()

    _engine_q.put((payload, _deliver))
    ev.wait()
    return box[0]


def _log(*a):
    print("[sidecar]", *a, file=sys.stderr, flush=True)


class Server(ThreadingHTTPServer):
    """Threaded HTTPServer that exits if it is orphaned (parent process died).

    The Electron supervisor may be SIGKILLed (crash, `timeout`, task manager)
    without a chance to reap us; without this the sidecar leaks.
    """
    daemon_threads = True  # don't let lingering keep-alive sockets block shutdown
    _start_ppid = os.getppid()

    def service_actions(self):
        # If our parent PID ever changes we have been orphaned (the Electron
        # supervisor died). Depending on the init system an orphan reparents to
        # PID 1 or to a subreaper, so compare against the launch-time parent
        # rather than checking for PID 1 specifically.
        if os.getppid() != self._start_ppid:
            _log("parent changed (%d -> %d) - orphaned, exiting" % (self._start_ppid, os.getppid()))
            os._exit(0)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # drop a silent / half-open keep-alive connection instead of pinning its
    # worker thread on a blocking read forever
    timeout = 65

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
        try:
            body = json.dumps(obj).encode("utf-8")
        except Exception as e:
            # a handler returned something json.dumps chokes on (e.g. a raw
            # FreeCAD Quantity instead of a plain number/string) - previously
            # this raised straight out of do_POST with no response ever sent,
            # which the client just sees as a dropped connection ("fetch
            # failed"), not a diagnosable error. Never let a bad result kill
            # the connection - report it as a clean JSON-RPC error instead.
            _log("response not JSON-serialisable: %r" % (e,))
            body = json.dumps({"jsonrpc": "2.0", "id": None, "error": {
                "code": -32000,
                "message": "internal error: response was not JSON-serialisable (%s)" % e
            }}).encode("utf-8")
            code = 200
        self._send(code, body)

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

        # hand the document work to the single engine thread; this connection
        # thread just waits for the answer and writes it back
        out = _run_on_engine(payload)
        if isinstance(payload, list):
            out = [r for r in out if r.get("id") is not None]
        self._json(200, out)

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
    threading.Thread(target=_engine_worker, name="gwtcad-engine", daemon=True).start()
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
