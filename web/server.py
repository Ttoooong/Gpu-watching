"""FastAPI server for GPU monitoring.

Layout:
- Background asyncio task wakes up every `interval_ms`, polls GPUMonitor,
  appends to a rolling history buffer, fans out to SSE subscribers, and
  appends to CSV.
- REST endpoints expose status and control. SSE endpoint (/api/stream)
  streams new samples as `data: <json>\\n\\n` lines.

Reuses `core.gpu_monitor.GPUMonitor` and `core.csv_logger.CSVLogger`
verbatim from the previous PyQt5 version.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import AsyncIterator, Deque, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.csv_logger import CSVLogger
from core.gpu_monitor import GPUMonitor, GPUSample
from core.system_monitor import SystemMonitor, SystemSample


log = logging.getLogger("gpu_monitor.web")

WEB_DIR = Path(__file__).resolve().parent
STATIC_DIR = WEB_DIR / "static"
LOG_DIR = WEB_DIR.parent / "logs"

_HISTORY_MAX = 600   # ~10 min at 1 Hz; chart redraws only what fits the window


# ---------- shared application state ----------


@dataclass
class AppState:
    running: bool = False
    interval_ms: int = 1000
    history: Deque[dict] = None  # list of {ts, samples: [...]}

    def __post_init__(self) -> None:
        if self.history is None:
            self.history = deque(maxlen=_HISTORY_MAX)


state = AppState()
monitor = GPUMonitor()
sysmon = SystemMonitor()
sysmon.prime()   # warm up psutil.cpu_percent so first real sample isn't 0
logger = CSVLogger(LOG_DIR)
_subscribers: List[asyncio.Queue] = []
_loop_task: Optional[asyncio.Task] = None


# ---------- background sampler ----------


async def _sampler_loop() -> None:
    """Poll forever while state.running, broadcasting to subscribers + CSV."""
    log.info("sampler loop started (interval=%d ms)", state.interval_ms)
    try:
        while state.running:
            samples = monitor.sample_all()
            sys_sample = sysmon.sample()
            now = datetime.now()
            payload = {
                "ts": now.isoformat(timespec="seconds"),
                "ts_epoch": now.timestamp(),
                "samples": [_sample_to_json(s) for s in samples],
                "sys": _sys_to_json(sys_sample),
            }
            state.history.append(payload)

            try:
                logger.write(samples, when=now)
                logger.write_system(sys_sample, when=now)
            except Exception:
                log.exception("CSV write failed")

            for q in list(_subscribers):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass  # drop slow clients silently

            await asyncio.sleep(state.interval_ms / 1000.0)
    except asyncio.CancelledError:
        log.info("sampler loop cancelled")
        raise
    finally:
        log.info("sampler loop exited")


def _sample_to_json(s: GPUSample) -> dict:
    return {
        "index": s.index,
        "name": s.name,
        "util_pct": s.util_pct,
        "mem_util_pct": s.mem_util_pct,
        "mem_used_mb": s.mem_used_mb,
        "mem_total_mb": s.mem_total_mb,
        "power_w": s.power_w,
        "temp_c": s.temp_c,
        "processes": [
            {"pid": p.pid, "name": p.name, "used_mem_mb": p.used_mem_mb}
            for p in s.processes
        ],
    }


def _sys_to_json(s: SystemSample) -> dict:
    return {
        "cpu_pct":        s.cpu_pct,
        "cpu_per_core":   list(s.cpu_per_core),
        "cpu_freq_mhz":   s.cpu_freq_mhz,
        "mem_pct":        s.mem_pct,
        "mem_used_mb":    s.mem_used_mb,
        "mem_total_mb":   s.mem_total_mb,
        "disk_pct":       s.disk_pct,
        "disk_used_gb":   s.disk_used_gb,
        "disk_total_gb":  s.disk_total_gb,
        "net_rx_mb_s":    s.net_rx_mb_s,
        "net_tx_mb_s":    s.net_tx_mb_s,
    }


async def _ensure_running() -> None:
    global _loop_task
    if _loop_task and not _loop_task.done():
        return
    state.running = True
    _loop_task = asyncio.create_task(_sampler_loop())


async def _ensure_stopped() -> None:
    global _loop_task
    state.running = False
    if _loop_task and not _loop_task.done():
        _loop_task.cancel()
        try:
            await _loop_task
        except asyncio.CancelledError:
            pass
    _loop_task = None


# ---------- FastAPI app ----------


app = FastAPI(title="GPU Monitor", version="1.0")


@app.on_event("shutdown")
async def _on_shutdown() -> None:  # pragma: no cover - lifecycle
    await _ensure_stopped()
    try:
        monitor.shutdown()
    except Exception:
        pass
    try:
        logger.close()   # closes both GPU and system file handles
    except Exception:
        pass


# Static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ---- Startup: optionally auto-start the sampler in uvicorn's own loop ----
# NOTE: never start the sampler from main.py — doing so creates the task in a
# throwaway loop, and uvicorn's request handlers will then `await` it from a
# different loop → "got Future attached to a different loop" RuntimeError.

# main.py sets this before importing/running the app. The env var is the
# fallback so `--reload` works too: uvicorn's reloader re-imports this module
# in a *child process*, where main.py's attribute assignment never happened.
auto_start: bool = os.environ.get("GPU_MONITOR_AUTO_START", "1") != "0"


@app.on_event("startup")
async def _on_startup() -> None:
    # Auto-start even when there are no NVIDIA GPUs — the system sampler
    # (CPU/RAM/disk/net) is still useful. The frontend falls back to
    # system-only cards when gpu_count == 0.
    if auto_start and (monitor.available or True):
        await _ensure_running()
        log.info("auto-started sampler (interval=%d ms)", state.interval_ms)


# ---- REST: read-only ----


@app.get("/api/history_dates")
async def get_history_dates() -> dict:
    """List all GPU CSV files on disk. The system CSV uses a dedicated
    endpoint at /api/system/history_dates. Kept as a sibling rather than
    mixed because the schema differs (long vs wide, gpu_index column, etc.).
    """
    files = logger.list_files()
    out: list[dict] = []
    for entry in files:
        if entry["source"] != "gpu":
            continue
        p = entry["path"]
        try:
            date_str = p.stem.replace("gpu_", "")
            first_iso = last_iso = None
            row_count = 0
            with open(p, "r", newline="") as f:
                rdr = csv.reader(f)
                next(rdr, None)
                for i, row in enumerate(rdr):
                    if not row:
                        continue
                    row_count += 1
                    if i == 0:
                        first_iso = row[0]
                    last_iso = row[0]
            out.append({
                "date": date_str,
                "source": "gpu",
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "row_count": row_count,
                "first_ts": first_iso,
                "last_ts": last_iso,
            })
        except OSError:
            continue
    return {"files": out}


@app.get("/api/system/history_dates")
async def get_system_history_dates() -> dict:
    """Same shape as /api/history_dates but for system_*.csv files."""
    files = logger.list_files()
    out: list[dict] = []
    for entry in files:
        if entry["source"] != "system":
            continue
        p = entry["path"]
        try:
            date_str = p.stem.replace("system_", "")
            first_iso = last_iso = None
            row_count = 0
            with open(p, "r", newline="") as f:
                rdr = csv.reader(f)
                next(rdr, None)
                for i, row in enumerate(rdr):
                    if not row:
                        continue
                    row_count += 1
                    if i == 0:
                        first_iso = row[0]
                    last_iso = row[0]
            out.append({
                "date": date_str,
                "source": "system",
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "row_count": row_count,
                "first_ts": first_iso,
                "last_ts": last_iso,
            })
        except OSError:
            continue
    return {"files": out}


def _parse_window(date: str, start: Optional[str], end: Optional[str]) -> tuple:
    try:
        d = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, f"无法解析日期: {date}")
    if start and len(start) <= 8:
        sh, sm = start.split(":")
        s = datetime(d.year, d.month, d.day, int(sh), int(sm))
    elif start:
        s = datetime.fromisoformat(start)
    else:
        s = datetime(d.year, d.month, d.day)
    if end and len(end) <= 8:
        eh, em = end.split(":")
        e = datetime(d.year, d.month, d.day, int(eh), int(em), 59)
    elif end:
        e = datetime.fromisoformat(end)
    else:
        e = datetime(d.year, d.month, d.day, 23, 59, 59)
    if s >= e:
        raise HTTPException(400, "start 必须早于 end")
    return s, e


@app.get("/api/history_query")
async def get_history_query(
    date: str = Query(..., description="YYYY-MM-DD"),
    start: Optional[str] = Query(None, description="本地时间 HH:MM 或 ISO"),
    end: Optional[str] = Query(None, description="本地时间 HH:MM 或 ISO"),
    gpu: Optional[int] = Query(None, description="GPU index, 缺省=全部"),
    max_rows: int = Query(5000, ge=100, le=50000),
) -> dict:
    """GPU history. Mirrors /api/export but returns JSON."""
    s, e = _parse_window(date, start, end)
    rows = logger.query(s, e, gpu_index=gpu, max_rows=max_rows)
    return {
        "source": "gpu",
        "date": date,
        "start": s.isoformat(timespec="seconds"),
        "end": e.isoformat(timespec="seconds"),
        "gpu_index": gpu,
        "row_count": len(rows),
        "truncated": len(rows) >= max_rows,
        "rows": rows,
    }


@app.get("/api/system/history_query")
async def get_system_history_query(
    date: str = Query(..., description="YYYY-MM-DD"),
    start: Optional[str] = Query(None, description="本地时间 HH:MM 或 ISO"),
    end: Optional[str] = Query(None, description="本地时间 HH:MM 或 ISO"),
    max_rows: int = Query(5000, ge=100, le=50000),
) -> dict:
    """System history (wide format). Returns one row per timestamp."""
    s, e = _parse_window(date, start, end)
    rows = logger.query_system(s, e, max_rows=max_rows)
    return {
        "source": "system",
        "date": date,
        "start": s.isoformat(timespec="seconds"),
        "end": e.isoformat(timespec="seconds"),
        "row_count": len(rows),
        "truncated": len(rows) >= max_rows,
        "rows": rows,
    }


@app.get("/api/status")
async def get_status() -> dict:
    last = state.history[-1] if state.history else None
    return {
        "available": monitor.available,
        "driver_version": monitor.driver_version,
        "gpu_count": monitor.count,
        "gpu_names": monitor.names,
        "running": state.running,
        "auto_start": auto_start,
        "interval_ms": state.interval_ms,
        "history_len": len(state.history),
        "current_csv": str(logger.current_path) if logger.current_path else None,
        "current_system_csv": str(logger.current_system_path) if logger.current_system_path else None,
        # psutil is always available on the host; this is mostly informational.
        "system_available": True,
        "system_last": last.get("sys") if last else None,
    }


@app.get("/api/history")
async def get_history() -> dict:
    """Return current in-memory rolling buffer (used for chart initial load)."""
    return {
        "interval_ms": state.interval_ms,
        "points": list(state.history),
    }


# ---- REST: control ----


class IntervalBody(BaseModel):
    interval_ms: int


@app.post("/api/control/start")
async def post_start() -> dict:
    # 允许无 GPU 时仅采样系统指标，所以这里不再检查 monitor.available。
    # 系统监控走 psutil，几乎总可用；GPU 不可用时 GPU 字段在 payload 里是 []。
    await _ensure_running()
    return {"running": True, "interval_ms": state.interval_ms}


@app.post("/api/control/stop")
async def post_stop() -> dict:
    await _ensure_stopped()
    return {"running": False, "interval_ms": state.interval_ms}


@app.post("/api/control/interval")
async def post_interval(body: IntervalBody) -> dict:
    ms = int(body.interval_ms)
    if ms < 100 or ms > 60_000:
        raise HTTPException(400, "interval_ms 必须在 100 ~ 60000 之间")
    state.interval_ms = ms
    if state.running:
        await _ensure_stopped()
        await _ensure_running()
    return {"running": state.running, "interval_ms": state.interval_ms}


@app.post("/api/control/clear")
async def post_clear() -> dict:
    state.history.clear()
    return {"history_len": 0}


@app.get("/api/export")
async def get_export(
    start: Optional[str] = Query(None, description="ISO 格式, 例 2026-08-28T14:00:00"),
    end: Optional[str] = Query(None, description="ISO 格式"),
    gpu: Optional[int] = Query(None, description="GPU index, 缺省=全部"),
) -> StreamingResponse:
    end_dt = _parse_dt(end) or datetime.now()
    start_dt = _parse_dt(start) or (end_dt - timedelta(hours=1))
    if start_dt >= end_dt:
        raise HTTPException(400, "start 必须早于 end")

    rows = logger.query(start_dt, end_dt, gpu_index=gpu)
    if not rows:
        raise HTTPException(404, "所选时间段内没有数据")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    buf.seek(0)

    fname = f"gpu_export_{end_dt.strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"无法解析时间: {s}")


# ---- SSE: live stream ----


@app.get("/api/stream")
async def stream(request: Request) -> StreamingResponse:
    """Server-Sent Events. One `data: {...}\\n\\n` per sample tick."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _subscribers.append(queue)
    log.info("SSE client connected (total=%d)", len(_subscribers))

    async def event_gen() -> AsyncIterator[bytes]:
        try:
            # Send a hello so the client knows the stream is live even before
            # the next tick.
            hello = json.dumps({"type": "hello", "interval_ms": state.interval_ms})
            yield _sse(hello)
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # heartbeat so proxies / browsers don't kill the connection
                    yield b": heartbeat\n\n"
                    continue
                yield _sse(json.dumps(payload, ensure_ascii=False))
        finally:
            try:
                _subscribers.remove(queue)
            except ValueError:
                pass
            log.info("SSE client disconnected (total=%d)", len(_subscribers))

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _sse(data: str) -> bytes:
    return f"data: {data}\n\n".encode("utf-8")