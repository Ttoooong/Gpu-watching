"""NVML-based GPU sampler.

Wraps `pynvml` so the rest of the app never touches raw NVML calls. Each GPU
metric fetch is independently wrapped in try/except so a single field failure
on one card (very common on WDDM consumer drivers) does not break the whole
sample.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import psutil

try:
    import pynvml
    _NVML_ERRORS = (pynvml.NVMLError,)
except ImportError:  # pragma: no cover - install failure path
    pynvml = None  # type: ignore[assignment]
    _NVML_ERRORS = ()


# NVML_VALUE_NOT_AVAILABLE sentinel: returned by some WDDM queries
# (e.g. per-process usedGpuMemory on consumer GeForce drivers).
# It's the largest unsigned 64-bit value; treat as missing.
_NVML_VALUE_NOT_AVAILABLE = (1 << 64) - 2


@dataclass
class ProcessInfo:
    pid: int
    name: str
    used_mem_mb: Optional[int]  # None on WDDM consumer drivers


@dataclass
class GPUSample:
    index: int
    name: str
    util_pct: Optional[float]
    mem_util_pct: Optional[float]
    mem_used_mb: Optional[int]
    mem_total_mb: int
    power_w: Optional[float]
    temp_c: Optional[int]
    processes: List[ProcessInfo] = field(default_factory=list)


class GPUMonitor:
    """Initializes NVML once, exposes a simple polling API.

    All public methods are safe to call even if NVML failed to initialize;
    `available` will be False and `sample_all()` returns an empty list.
    """

    def __init__(self) -> None:
        self._available = False
        self._count = 0
        self._handles: list = []
        self._names: list[str] = []
        self._total_mem: list[int] = []
        self._driver_version: str = "N/A"

        if pynvml is None:
            return

        try:
            pynvml.nvmlInit()
        except _NVML_ERRORS as e:  # noqa: PERF203 - we want a bare log
            # LibraryNotFound / DriverNotLoaded / GpuNotFound / Unknown
            print(f"[GPUMonitor] NVML init failed: {type(e).__name__}: {e}")
            return

        try:
            self._driver_version = pynvml.nvmlSystemGetDriverVersion()
            self._driver_version = self._driver_version.decode() if isinstance(
                self._driver_version, bytes
            ) else self._driver_version
        except _NVML_ERRORS:
            pass

        try:
            self._count = pynvml.nvmlDeviceGetCount()
        except _NVML_ERRORS:
            return

        for i in range(self._count):
            try:
                h = pynvml.nvmlDeviceGetHandleByIndex(i)
                name_raw = pynvml.nvmlDeviceGetName(h)
                name = name_raw.decode() if isinstance(name_raw, bytes) else name_raw
                mem_info = pynvml.nvmlDeviceGetMemoryInfo(h)
                self._handles.append(h)
                self._names.append(name)
                self._total_mem.append(int(mem_info.total // (1024 * 1024)))
            except _NVML_ERRORS:
                # Skip cards we cannot enumerate, but keep others.
                continue

        self._count = len(self._handles)
        self._available = self._count > 0

    # ---- public read-only state ----

    @property
    def available(self) -> bool:
        return self._available

    @property
    def count(self) -> int:
        return self._count

    @property
    def driver_version(self) -> str:
        return self._driver_version

    @property
    def names(self) -> list[str]:
        return list(self._names)

    # ---- sampling ----

    def sample_all(self) -> List[GPUSample]:
        """Poll every GPU once. Returns one GPUSample per card."""
        if not self._available:
            return []

        samples: list[GPUSample] = []
        for i, h in enumerate(self._handles):
            samples.append(self._sample_one(i, h))
        return samples

    def _sample_one(self, i: int, h) -> GPUSample:
        util_pct: Optional[float] = None
        mem_util_pct: Optional[float] = None
        mem_used_mb: Optional[int] = None
        power_w: Optional[float] = None
        temp_c: Optional[int] = None
        processes: list[ProcessInfo] = []

        try:
            u = pynvml.nvmlDeviceGetUtilizationRates(h)
            util_pct = float(u.gpu)
            mem_util_pct = float(u.memory)
        except _NVML_ERRORS:
            pass

        try:
            m = pynvml.nvmlDeviceGetMemoryInfo(h)
            mem_used_mb = int(m.used // (1024 * 1024))
        except _NVML_ERRORS:
            pass

        try:
            pw = pynvml.nvmlDeviceGetPowerUsage(h)  # milliwatts
            power_w = round(pw / 1000.0, 1)
        except _NVML_ERRORS:
            pass

        try:
            temp_c = int(
                pynvml.nvmlDeviceGetTemperature(
                    h, pynvml.NVML_TEMPERATURE_GPU
                )
            )
        except _NVML_ERRORS:
            pass

        try:
            raw_procs = pynvml.nvmlDeviceGetComputeRunningProcesses(h)
        except _NVML_ERRORS:
            raw_procs = []

        for p in raw_procs:
            used = p.usedGpuMemory
            mem_mb: Optional[int]
            if used is None or used == _NVML_VALUE_NOT_AVAILABLE:
                mem_mb = None
            else:
                mem_mb = int(used // (1024 * 1024))

            try:
                name = psutil.Process(p.pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                name = f"pid:{p.pid}"

            processes.append(ProcessInfo(pid=int(p.pid), name=name, used_mem_mb=mem_mb))

        processes.sort(key=lambda x: x.pid)

        return GPUSample(
            index=i,
            name=self._names[i],
            util_pct=util_pct,
            mem_util_pct=mem_util_pct,
            mem_used_mb=mem_used_mb,
            mem_total_mb=self._total_mem[i],
            power_w=power_w,
            temp_c=temp_c,
            processes=processes,
        )

    def shutdown(self) -> None:
        if not self._available:
            return
        try:
            pynvml.nvmlShutdown()
        except _NVML_ERRORS:
            pass
        self._available = False