"""System resource sampler.

Wraps `psutil` so the rest of the app never touches raw psutil calls.
Mirrors `gpu_monitor.GPUMonitor` for symmetry:
- `sample()` → SystemSample (cheap, on demand)
- No background thread; the sampler loop in web/server.py calls us once per tick.

Network throughput is rate-based, so we keep the previous counters in memory
and compute bytes/sec on each new sample. First sample after start yields
rate = 0 (no delta yet).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import List, Optional

import psutil


@dataclass
class SystemSample:
    cpu_pct: Optional[float]            # total utilization %
    cpu_per_core: List[float] = field(default_factory=list)
    cpu_freq_mhz: Optional[float] = None
    mem_used_mb: Optional[int] = None
    mem_total_mb: Optional[int] = None
    mem_pct: Optional[float] = None
    disk_used_gb: Optional[float] = None
    disk_total_gb: Optional[float] = None
    disk_pct: Optional[float] = None
    net_rx_mb_s: Optional[float] = None   # MB/s, computed from prev sample
    net_tx_mb_s: Optional[float] = None


class SystemMonitor:
    """Always available — psutil works on every OS."""

    def __init__(self, disk_path: str = "/") -> None:
        self._disk_path = disk_path
        # Network rate state. Initialised lazily on first sample to handle
        # the case where psutil.net_io_counters() can't be read (rare).
        self._prev_rx = 0
        self._prev_tx = 0
        self._prev_ts: Optional[float] = None

    # ---- public API ----

    def sample(self) -> SystemSample:
        now = time.monotonic()

        # CPU — psutil.cpu_percent needs a delta to compute %; the first call
        # returns 0, then it works. We do an initial no-op read at boot in
        # _prime_cpu().
        try:
            cpu_pct = float(psutil.cpu_percent(interval=None))
        except Exception:
            cpu_pct = None
        try:
            per_core = [float(x) for x in psutil.cpu_percent(interval=None, percpu=True)]
        except Exception:
            per_core = []
        try:
            freq = psutil.cpu_freq()
            cpu_freq_mhz = float(freq.current) if freq and freq.current else None
        except Exception:
            cpu_freq_mhz = None

        # Memory
        try:
            vm = psutil.virtual_memory()
            mem_used_mb = int(vm.used // (1024 * 1024))
            mem_total_mb = int(vm.total // (1024 * 1024))
            mem_pct = float(vm.percent)
        except Exception:
            mem_used_mb = mem_total_mb = mem_pct = None

        # Disk — chosen path. Use shutil to avoid a free() call.
        try:
            du = psutil.disk_usage(self._disk_path)
            disk_used_gb = round(du.used / (1024 ** 3), 2)
            disk_total_gb = round(du.total / (1024 ** 3), 2)
            disk_pct = float(du.percent)
        except Exception:
            disk_used_gb = disk_total_gb = disk_pct = None

        # Network — aggregate across all NICs. First sample after init has
        # no prev → rate = 0 instead of bogus infinity.
        try:
            io = psutil.net_io_counters()
            rx = int(io.bytes_recv)
            tx = int(io.bytes_sent)
        except Exception:
            rx = tx = None

        rx_mb_s = tx_mb_s = 0.0
        if rx is not None and tx is not None and self._prev_ts is not None:
            dt = now - self._prev_ts
            if dt > 0:
                rx_mb_s = (rx - self._prev_rx) / dt / (1024 * 1024)
                tx_mb_s = (tx - self._prev_tx) / dt / (1024 * 1024)
        if rx is not None and tx is not None:
            self._prev_rx = rx
            self._prev_tx = tx
            self._prev_ts = now

        return SystemSample(
            cpu_pct=cpu_pct,
            cpu_per_core=per_core,
            cpu_freq_mhz=cpu_freq_mhz,
            mem_used_mb=mem_used_mb,
            mem_total_mb=mem_total_mb,
            mem_pct=mem_pct,
            disk_used_gb=disk_used_gb,
            disk_total_gb=disk_total_gb,
            disk_pct=disk_pct,
            net_rx_mb_s=round(rx_mb_s, 3) if rx is not None else None,
            net_tx_mb_s=round(tx_mb_s, 3) if tx is not None else None,
        )

    def prime(self) -> None:
        """First-call warmup so cpu_percent has a baseline to measure against.

        Call this once on startup, then ignore the returned value.
        """
        try:
            psutil.cpu_percent(interval=None)
            psutil.cpu_percent(interval=None, percpu=True)
        except Exception:
            pass