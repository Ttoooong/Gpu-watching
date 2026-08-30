"""GPU Monitor — entry point.

Launches the FastAPI/uvicorn server on 0.0.0.0:8000 so any device on the
LAN can open http://<host>:8000 in a browser.

CLI flags (all optional):
  --host HOST   Bind address (default 0.0.0.0)
  --port PORT   TCP port (default 8000)
  --no-auto     Do not auto-start sampling on launch
"""

from __future__ import annotations

import argparse
import logging
import os

import uvicorn

import web.server as ws  # noqa: F401  (sets up app, state, monitor, logger)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GPU monitoring web server")
    p.add_argument("--host", default="0.0.0.0", help="Bind address")
    p.add_argument("--port", type=int, default=8000, help="TCP port")
    p.add_argument("--no-auto", action="store_true",
                   help="Do not auto-start sampling on launch")
    p.add_argument("--reload", action="store_true",
                   help="Dev mode: reload on file changes (uvicorn --reload)")
    return p.parse_args()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    args = parse_args()

    # Tell the FastAPI app whether to start the sampler at startup.
    # IMPORTANT: this must run inside uvicorn's event loop, so it's wired
    # via @app.on_event("startup") in web/server.py — NOT here.
    # The env var carries the same flag across uvicorn's --reload child
    # process, which re-imports web.server and never sees this assignment.
    os.environ["GPU_MONITOR_AUTO_START"] = "0" if args.no_auto else "1"
    ws.auto_start = not args.no_auto

    # reload=True requires an import string; passing the app object makes
    # uvicorn warn and silently disable reloading.
    target = "web.server:app" if args.reload else ws.app

    uvicorn.run(
        target,
        host=args.host,
        port=args.port,
        log_level="info",
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())