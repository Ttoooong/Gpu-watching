"""Crash-safe CSV logger.

Two writers share one log directory:
- GPU rows in *long* format (one row per (timestamp, gpu)) so the file stays
  correct when the GPU count changes between launches. Filename `gpu_*.csv`.
- System rows in *wide* format (one row per timestamp = whole-machine snapshot)
  to avoid duplicating CPU/RAM/disk values per GPU. Filename `system_*.csv`.

Files are rotated at midnight local time. Each row is line-buffered and
fsync'd so a hard kill (`taskkill /F`) never leaves a half-written line.
"""

from __future__ import annotations

import csv
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, List, Optional

from .gpu_monitor import GPUSample
from .system_monitor import SystemSample


_GPU_HEADER = [
    "timestamp_iso",
    "gpu_index",
    "gpu_name",
    "util_pct",
    "mem_util_pct",
    "mem_used_mb",
    "mem_total_mb",
    "power_w",
    "temp_c",
]


# Per-core CPU columns are emitted as `cpu_core_0`, `cpu_core_1`, ... so the
# number of cores is recorded in the file itself; readers can detect missing
# columns gracefully.
def _sys_header(n_cores: int) -> list[str]:
    h = [
        "timestamp_iso",
        "cpu_pct",
        "mem_pct", "mem_used_mb", "mem_total_mb",
        "disk_pct", "disk_used_gb", "disk_total_gb",
        "net_rx_mb_s", "net_tx_mb_s",
        "cpu_freq_mhz",
    ]
    h.extend(f"cpu_core_{i}" for i in range(n_cores))
    return h


def _fmt(v) -> str:
    """Render nullable value for CSV: empty cell for None, else str()."""
    return "" if v is None else str(v)


class CSVLogger:
    """Append-only CSV writer for both GPU rows and system rows."""

    def __init__(self, log_dir: str | os.PathLike) -> None:
        self._dir = Path(log_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        # GPU file handle state
        self._file = None
        self._writer = None
        self._current_date: Optional[date] = None
        # System file handle state
        self._sys_file = None
        self._sys_writer = None
        self._sys_current_date: Optional[date] = None
        # 当天 system 文件的总列数（含 cpu_core_*）—— 由首次写入决定；
        # 旧文件不会变，跨天重新计。
        self._sys_n_cols = 0

    # ---- internal helpers ----

    def _path_for(self, d: date, source: str = "gpu") -> Path:
        prefix = "gpu_" if source == "gpu" else "system_"
        return self._dir / f"{prefix}{d.isoformat()}.csv"

    def _open_for(self, d: date) -> None:
        self._close()
        path = self._path_for(d, "gpu")
        new_file = not path.exists()
        # newline="" disables Python's universal-newline translation so csv
        # controls line endings; buffering=1 line-buffers writes.
        self._file = open(path, "a", newline="", buffering=1)
        self._writer = csv.writer(self._file)
        if new_file:
            self._writer.writerow(_GPU_HEADER)
            self._file.flush()
        self._current_date = d

    def _open_sys_for(self, d: date, n_cores: int) -> None:
        self._close_sys()
        path = self._path_for(d, "system")
        new_file = not path.exists()
        self._sys_file = open(path, "a", newline="", buffering=1)
        self._sys_writer = csv.writer(self._sys_file)
        # 决定列数：若文件已存在，沿用旧 header 的核数，避免和之前不一致
        # 的行混进同一个文件里。这里用传入的 n_cores，仅当新文件生效。
        if new_file:
            self._sys_writer.writerow(_sys_header(n_cores))
            self._sys_file.flush()
        self._sys_n_cols = len(_sys_header(n_cores))
        self._sys_current_date = d

    def _close(self) -> None:
        if self._file is not None:
            try:
                self._file.flush()
                os.fsync(self._file.fileno())
            except (OSError, ValueError):
                pass
            self._file.close()
        self._file = None
        self._writer = None
        self._current_date = None

    def _close_sys(self) -> None:
        if self._sys_file is not None:
            try:
                self._sys_file.flush()
                os.fsync(self._sys_file.fileno())
            except (OSError, ValueError):
                pass
            self._sys_file.close()
        self._sys_file = None
        self._sys_writer = None
        self._sys_current_date = None
        self._sys_n_cols = 0

    # ---- public API ----

    @property
    def current_path(self) -> Optional[Path]:
        if self._current_date is None:
            return None
        return self._path_for(self._current_date, "gpu")

    @property
    def current_system_path(self) -> Optional[Path]:
        if self._sys_current_date is None:
            return None
        return self._path_for(self._sys_current_date, "system")

    def write(self, samples: Iterable[GPUSample], when: Optional[datetime] = None) -> None:
        """Write one row per sample. Performs date rollover check first."""
        ts = when or datetime.now()
        d = ts.date()
        if self._current_date != d:
            self._open_for(d)
        assert self._writer is not None

        ts_iso = ts.isoformat(timespec="seconds")
        for s in samples:
            self._writer.writerow([
                ts_iso,
                s.index,
                s.name,
                _fmt(s.util_pct),
                _fmt(s.mem_util_pct),
                _fmt(s.mem_used_mb),
                _fmt(s.mem_total_mb),
                _fmt(s.power_w),
                _fmt(s.temp_c),
            ])
            # Crash safety: flush + fsync per row.
            # At 1 Hz sampling the ~1-10 ms cost is irrelevant.
            try:
                self._file.flush()
                os.fsync(self._file.fileno())
            except (OSError, ValueError):
                pass

    def write_system(self, s: SystemSample, when: Optional[datetime] = None) -> None:
        """Write one wide row for a system snapshot. Handles date rollover."""
        ts = when or datetime.now()
        d = ts.date()
        n_cores = len(s.cpu_per_core)
        # 如果当天文件已开但核数变了（理论上不会发生），强制关掉重开
        if self._sys_current_date != d:
            self._open_sys_for(d, n_cores)
        elif self._sys_n_cols > 0 and n_cores > 0 and self._sys_n_cols != len(_sys_header(n_cores)):
            self._open_sys_for(d, n_cores)
        if self._sys_writer is None:
            self._open_sys_for(d, n_cores)
        assert self._sys_writer is not None

        ts_iso = ts.isoformat(timespec="seconds")
        row = [
            ts_iso,
            _fmt(s.cpu_pct),
            _fmt(s.mem_pct), _fmt(s.mem_used_mb), _fmt(s.mem_total_mb),
            _fmt(s.disk_pct), _fmt(s.disk_used_gb), _fmt(s.disk_total_gb),
            _fmt(s.net_rx_mb_s), _fmt(s.net_tx_mb_s),
            _fmt(s.cpu_freq_mhz),
        ]
        row.extend(_fmt(c) for c in s.cpu_per_core)
        # 对齐到已建文件的列数
        if self._sys_n_cols > 0 and len(row) < self._sys_n_cols:
            row.extend([""] * (self._sys_n_cols - len(row)))
        elif self._sys_n_cols > 0 and len(row) > self._sys_n_cols:
            row = row[:self._sys_n_cols]
        self._sys_writer.writerow(row)
        try:
            self._sys_file.flush()
            os.fsync(self._sys_file.fileno())
        except (OSError, ValueError):
            pass

    def query(
        self,
        start: datetime,
        end: datetime,
        gpu_index: Optional[int] = None,
        max_rows: Optional[int] = None,
    ) -> List[dict]:
        """Read back rows in a time window across one or more date files.

        Used by the "Export" button and the history viewer.
        `max_rows` caps the result count to keep large windows from blowing
        the request size — when hit, rows are uniformly sub-sampled by
        stride so the time distribution stays even.
        """
        all_rows: list[dict] = []
        d = start.date()
        end_d = end.date()
        while d <= end_d:
            path = self._path_for(d, "gpu")
            if path.exists():
                with open(path, "r", newline="") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        try:
                            ts = datetime.fromisoformat(row["timestamp_iso"])
                        except (KeyError, ValueError):
                            continue
                        if ts < start or ts > end:
                            continue
                        if gpu_index is not None:
                            try:
                                if int(row["gpu_index"]) != gpu_index:
                                    continue
                            except (KeyError, ValueError):
                                continue
                        all_rows.append(row)
            d = d + timedelta(days=1)

        if max_rows is not None and len(all_rows) > max_rows:
            stride = (len(all_rows) + max_rows - 1) // max_rows
            all_rows = all_rows[::stride]
        return all_rows

    def query_system(
        self,
        start: datetime,
        end: datetime,
        max_rows: Optional[int] = None,
    ) -> List[dict]:
        """Wide-format system query. Returns rows in chronological order."""
        all_rows: list[dict] = []
        d = start.date()
        end_d = end.date()
        while d <= end_d:
            path = self._path_for(d, "system")
            if path.exists():
                with open(path, "r", newline="") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        try:
                            ts = datetime.fromisoformat(row["timestamp_iso"])
                        except (KeyError, ValueError):
                            continue
                        if ts < start or ts > end:
                            continue
                        all_rows.append(row)
            d = d + timedelta(days=1)

        all_rows.sort(key=lambda r: r.get("timestamp_iso", ""))
        if max_rows is not None and len(all_rows) > max_rows:
            stride = (len(all_rows) + max_rows - 1) // max_rows
            all_rows = all_rows[::stride]
        return all_rows

    def list_files(self) -> List[dict]:
        """Both GPU and system files, newest first, with source label."""
        files: list[dict] = []
        for p in self._dir.glob("gpu_*.csv"):
            files.append({"source": "gpu", "path": p})
        for p in self._dir.glob("system_*.csv"):
            files.append({"source": "system", "path": p})
        files.sort(key=lambda d: d["path"].name, reverse=True)
        return files

    def close(self) -> None:
        self._close()
        self._close_sys()