#!/usr/bin/env python3
"""Serve RobotEvolve locally.

    python serve.py            -> http://localhost:8000
    python serve.py 8080       -> http://localhost:8080
    python serve.py --no-open  -> do not launch a browser

A server is required: the page loads data/*.json with fetch(), which browsers
refuse to do from file:// URLs.
"""
import http.server
import os
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    # Browsers open speculative connections and sometimes never send a request on
    # them. Without a timeout those sockets sit in readline() forever, leaking a
    # thread each; 10s is far longer than a real request on localhost needs.
    timeout = 10

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # data files change constantly during editing; never let the browser cache them
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            sys.stderr.write("  404  %s\n" % (fmt % args))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    port = int(args[0]) if args else 8000
    launch = "--no-open" not in sys.argv

    try:
        # Threaded, and not for speed. A single-threaded server accepts a connection
        # and then blocks in rfile.readline() until a request arrives — so one browser
        # preconnect that never sends anything wedges the whole server inside a C-level
        # recv(), where Ctrl-C cannot reach it and serve_forever()'s poll loop never
        # runs again. daemon_threads also stops a stuck connection blocking exit.
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        print("Could not bind port %d: %s" % (port, e))
        print("Try:  python serve.py %d" % (port + 1))
        return 1

    url = "http://localhost:%d/" % port
    print("RobotEvolve  ->  %s" % url)
    print("Ctrl-C to stop.")
    if launch:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
