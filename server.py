#!/usr/bin/env python3
"""Serve the local EasyPlate browser interface."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


class EasyPlateHandler(SimpleHTTPRequestHandler):
    server_version = "EasyPlateLocal/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("EasyPlate: " + format % args + "\n")


def serve(*, port: int = 8765, open_browser: bool = False) -> None:
    host = "127.0.0.1"
    server = ThreadingHTTPServer((host, port), EasyPlateHandler)
    url = f"http://{host}:{port}"
    print(f"EasyPlate is running at {url}")
    print("Open this address in a browser on this computer.")
    print("Press Ctrl+C to stop.")
    if open_browser:
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEasyPlate stopped.")
    finally:
        server.server_close()


def parse_args(*, browser_option: bool) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start the local EasyPlate browser app")
    parser.add_argument("--port", type=int, default=8765, help="local port (default: 8765)")
    if browser_option:
        parser.add_argument("--no-browser", action="store_true", help="do not open a browser automatically")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    return args


def main() -> None:
    args = parse_args(browser_option=False)
    serve(port=args.port)


def launch() -> None:
    args = parse_args(browser_option=True)
    serve(port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
