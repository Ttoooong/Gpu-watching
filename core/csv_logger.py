"""Crash-safe CSV logger.

Appends one row per sample in *long* format (one row per (timestamp, gpu))
so the file stays correct when the GPU count changes between launches.

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


_HEADER = [
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


def _fmt(v) -> str:
    """Render nullable value for CSV: empty cell for None, else str()."""
    return "" if v is None else str(v)


class CSVLogger:
    """Append-only CSV writer with date-based file rotation."""

    def __init__(self, log_dir: str | os.PathLike) -> None:
        self._dir = Path(log_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._file = None
        self._writer = None
        self._current_date: Optional[date] = None

    # ---- internal helpers ----

    def _path_for(self, d: date) -> Path:
        return self._dir / f"gpu_{d.isoformat()}.csv"

    def _open_for(self, d: date) -> None:
        self._close()
        path = self._path_for(d)
        new_file = not path.exists()
        # newline="" disables Python's universal-newline translation so csv
        # controls line endings; buffering=1 line-buffers writes.
        self._file = open(path, "a", newline="", buffering=1)
        self._writer = csv.writer(self._file)
        if new_file:
            self._writer.writerow(_HEADER)
            self._file.flush()
        self._current_date = d

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

    # ---- public API ----

    @property
    def current_path(self) -> Optional[Path]:
        if self._current_date is None:
            return None
        return self._path_for(self._current_date)

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

    def query(
        self,
        start: datetime,
        end: datetime,
        gpu_index: Optional[int] = None,
    ) -> List[dict]:
        """Read back rows in a time window across one or more date files.

        Used by the "Export" button to filter historical data.
        """
        rows: list[dict] = []
        d = start.date()
        end_d = end.date()
        while d <= end_d:
            path = self._path_for(d)
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
                        rows.append(row)
            d = d + timedelta(days=1)
        return rows

    def list_files(self) -> List[Path]:
        """All CSV files currently on disk, newest first."""
        return sorted(self._dir.glob("gpu_*.csv"), reverse=True)

    def close(self) -> None:
        self._close()