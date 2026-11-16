"""Validated SQLite snapshots; only complete files enter the backup directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager

VERSION = "1"
SNAPSHOT_NAME = re.compile(r"deepdish-\d{8}-\d{6}(?:-[0-9a-f]{8})?\.db\Z")
ERRORS = {
    "source_missing", "snapshot_failed", "snapshot_invalid", "publish_failed",
    "storage_unavailable", "status_write_failed", "rotation_failed", "snapshot_missing",
}


class BackupFailure(Exception):
    pass


def fsync_directory(path: Path) -> None:
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_json(path: Path, payload: dict, staging: Path) -> None:
    temporary = staging / (uuid.uuid4().hex + ".json.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(payload, stream, ensure_ascii=True, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)  # Fail on EXDEV; never fall back to copy.
        fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def process_lock(path: Path):
    with path.open("a+b") as stream:
        os.chmod(path, 0o600)
        stream.seek(0, os.SEEK_END)
        if not stream.tell():
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise BlockingIOError from exc
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def read_report(directory: Path) -> dict:
    path = directory / "backup-status.json"
    if path.stat().st_size > 16384:
        raise ValueError("status_invalid")
    report = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(report, dict) or report.get("schema") != 1 or report.get("generator") != VERSION:
        raise ValueError("status_invalid")
    for name in ("checked_at", "last_success_at", "last_attempt_at"):
        value = report.get(name)
        if value is not None and (not isinstance(value, (float, int))
                                  or not math.isfinite(value) or value <= 0):
            raise ValueError("status_invalid")
    for name in ("error_code", "warning_code"):
        if report.get(name) is not None and report[name] not in ERRORS:
            raise ValueError("status_invalid")
    filename = report.get("snapshot")
    if filename is not None:
        if not isinstance(filename, str) or not SNAPSHOT_NAME.fullmatch(filename):
            raise ValueError("status_invalid")
        snapshot = directory / filename
        if snapshot.is_symlink() or not snapshot.is_file():
            raise ValueError("snapshot_missing")
        size = report.get("snapshot_bytes")
        if not isinstance(size, int) or size < 512 or snapshot.stat().st_size != size:
            raise ValueError("snapshot_invalid")
        if not re.fullmatch(r"[0-9a-f]{64}", str(report.get("snapshot_sha256", ""))):
            raise ValueError("status_invalid")
    return report


def report_health(report: dict, now: float, max_age: float, heartbeat_age: float) -> dict:
    success = report.get("last_success_at")
    checked = report.get("checked_at")
    age = None if success is None else max(0, int(now - success))
    code = report.get("error_code") or report.get("warning_code")
    if any(value is not None and value > now + 60 for value in (success, checked)):
        state = "clock_error"
    elif checked is None or now - checked > heartbeat_age:
        state = "worker_stale"
    elif success is None or not report.get("snapshot"):
        state = "missing"
    elif code:
        state = "error"
    elif now - success > max_age:
        state = "stale"
    else:
        state = "ok"
    return {
        "healthy": state == "ok", "state": state, "generator": VERSION,
        "last_success_at": success, "age_seconds": age, "error_code": code,
    }


class BackupManager:
    def __init__(self, db_path, directory, staging, *, interval=21600,
                 max_age=28800, poll=60, retry=300, heartbeat_age=180, keep=30,
                 clock=time.time, logger=None):
        if (not all(math.isfinite(v) and v > 0
                    for v in (interval, max_age, poll, retry, heartbeat_age))
                or max_age < interval or heartbeat_age < poll or keep < 2):
            raise ValueError("invalid_backup_configuration")
        self.db = Path(db_path).absolute()
        self.directory = Path(directory).absolute()
        self.staging = Path(staging).absolute()
        if self.directory in self.db.parents or self.staging in self.db.parents:
            raise ValueError("source_must_be_outside_backup_and_staging")
        if self.directory == self.staging or self.directory in self.staging.parents:
            raise ValueError("staging_must_be_outside_backup_directory")
        self.interval, self.max_age = interval, max_age
        self.poll, self.retry, self.heartbeat_age = poll, retry, heartbeat_age
        self.keep, self.clock = keep, clock
        self.log = logger or logging.getLogger("deepdish")
        self._run_lock, self._state_lock = threading.Lock(), threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._state = {
            "schema": 1, "generator": VERSION, "checked_at": None,
            "last_success_at": None, "last_attempt_at": None,
            "snapshot": None, "snapshot_bytes": None, "snapshot_sha256": None,
            "error_code": None, "warning_code": None,
        }
        try:
            old = read_report(self.directory)
            if old.get("snapshot"):
                saved = self.directory / old["snapshot"]
                self._validate(saved)
                with saved.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != old["snapshot_sha256"]:
                        raise ValueError("snapshot_invalid")
            self._state.update({k: old.get(k) for k in self._state})
        except (OSError, ValueError, TypeError, BackupFailure):
            pass

    def _vacuum(self, temporary: Path) -> None:
        if not self.db.is_file():
            raise BackupFailure("source_missing")
        deadline = time.monotonic() + 120
        try:
            with closing(sqlite3.connect(self.db.as_uri() + "?mode=ro", uri=True, timeout=5)) as conn:
                conn.set_progress_handler(
                    lambda: int(self._stop.is_set() or time.monotonic() > deadline), 10000)
                conn.execute("VACUUM INTO ?", (str(temporary),))
        except sqlite3.Error as exc:
            raise BackupFailure("snapshot_failed") from exc

    def _validate(self, temporary: Path) -> None:
        try:
            with closing(sqlite3.connect(temporary.as_uri() + "?mode=ro&immutable=1", uri=True)) as conn:
                if conn.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise BackupFailure("snapshot_invalid")
                if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise BackupFailure("snapshot_invalid")
        except sqlite3.Error as exc:
            raise BackupFailure("snapshot_invalid") from exc

    def _create(self) -> dict:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(self.clock()))
        filename = f"deepdish-{stamp}-{uuid.uuid4().hex[:8]}.db"
        temporary = self.staging / (uuid.uuid4().hex + ".sqlite.tmp")
        final = self.directory / filename
        committed = False
        try:
            self._vacuum(temporary)
            os.chmod(temporary, 0o600)
            self._validate(temporary)
            with temporary.open("r+b") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
                os.fsync(stream.fileno())
            manifest = {
                "schema": 1, "generator": VERSION, "snapshot": filename,
                "snapshot_bytes": temporary.stat().st_size,
                "snapshot_sha256": digest, "created_at": self.clock(),
                "quick_check": "ok", "foreign_key_check": "ok",
            }
            try:
                os.replace(temporary, final)
                fsync_directory(self.directory)
                atomic_json(self.directory / (filename + ".json"), manifest, self.staging)
            except OSError as exc:
                raise BackupFailure("publish_failed") from exc
            committed = True
            return manifest
        finally:
            temporary.unlink(missing_ok=True)
            if not committed:
                final.unlink(missing_ok=True)
                (self.directory / (filename + ".json")).unlink(missing_ok=True)

    def _prune(self) -> None:
        snapshots = sorted(
            (p for p in self.directory.iterdir()
             if SNAPSHOT_NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()),
            key=lambda p: p.name)
        # Always retain the referenced generation, even after a clock adjustment.
        with self._state_lock:
            current = self._state["snapshot"]
        others = [p for p in snapshots if p.name != current]
        count = self.keep - int(any(p.name == current for p in snapshots))
        for old in others[:-count] if count else others:
            old.unlink()
            (self.directory / (old.name + ".json")).unlink(missing_ok=True)

    def health(self) -> dict:
        with self._state_lock:
            state = dict(self._state)
        health = report_health(state, self.clock(), self.max_age, self.heartbeat_age)
        if state.get("snapshot") and not (self.directory / state["snapshot"]).is_file():
            health.update(healthy=False, state="error", error_code="snapshot_missing")
        return health

    def tick(self, *, force=False) -> bool:
        if not self._run_lock.acquire(blocking=False):
            return False
        made = False
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.staging.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.staging, 0o700)
            with process_lock(self.staging / ".lock"):
                for leftover in self.staging.iterdir():
                    if re.fullmatch(r"[0-9a-f]{32}\.(?:sqlite|json)\.tmp", leftover.name):
                        leftover.unlink()
                # An OS lock also protects against a second uvicorn worker.
                try:
                    persisted = read_report(self.directory)
                    with self._state_lock:
                        if (persisted.get("last_success_at") or 0) > (self._state["last_success_at"] or 0):
                            self._state.update({k: persisted.get(k) for k in self._state})
                except (OSError, ValueError, TypeError):
                    pass
                now = self.clock()
                with self._state_lock:
                    self._state["checked_at"] = now
                    if self._state["snapshot"] and not (self.directory / self._state["snapshot"]).is_file():
                        self._state["error_code"] = "snapshot_missing"
                    last = self._state["last_success_at"]
                    attempt = self._state["last_attempt_at"]
                    error = self._state["error_code"]
                due = force or last is None or now - last >= self.interval or error not in (None, "status_write_failed")
                if due and (force or attempt is None or now - attempt >= self.retry):
                    with self._state_lock:
                        self._state["last_attempt_at"] = now
                    try:
                        manifest = self._create()
                        with self._state_lock:
                            self._state.update({
                                "last_success_at": self.clock(), "error_code": None,
                                "snapshot": manifest["snapshot"],
                                "snapshot_bytes": manifest["snapshot_bytes"],
                                "snapshot_sha256": manifest["snapshot_sha256"],
                            })
                        made = True
                        self.log.info("backup_complete generator=%s", VERSION)
                    except (BackupFailure, OSError) as exc:
                        code = str(exc) if isinstance(exc, BackupFailure) else "storage_unavailable"
                        with self._state_lock:
                            self._state["error_code"] = code
                        self.log.error("backup_failed code=%s", code)
                with self._state_lock:
                    warning = self._state["warning_code"]
                if made or warning == "rotation_failed":
                    try:
                        self._prune()
                        with self._state_lock:
                            self._state["warning_code"] = None
                    except OSError:
                        with self._state_lock:
                            self._state["warning_code"] = "rotation_failed"
                        self.log.error("backup_failed code=rotation_failed")
                with self._state_lock:
                    if self._state["error_code"] == "status_write_failed":
                        self._state["error_code"] = None
                    self._state["checked_at"] = self.clock()
                    report = dict(self._state)
                try:
                    atomic_json(self.directory / "backup-status.json", report, self.staging)
                except OSError:
                    with self._state_lock:
                        self._state["error_code"] = "status_write_failed"
                    self.log.error("backup_failed code=status_write_failed")
        except BlockingIOError:
            pass
        except OSError:
            with self._state_lock:
                self._state["error_code"] = "storage_unavailable"
            self.log.error("backup_failed code=storage_unavailable")
        finally:
            self._run_lock.release()
        return made

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                with self._state_lock:
                    self._state["error_code"] = "storage_unavailable"
                self.log.error("backup_failed code=storage_unavailable")
            if self._stop.wait(self.poll):
                break

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="sqlite-backup", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)


def configured_paths():
    base = Path(__file__).resolve().parent
    return (
        Path(os.environ.get("DD_BACKUP_DIR", str(base / "data" / "backups"))),
        Path(os.environ.get("DD_BACKUP_STAGING_DIR", str(base / ".backup-staging"))),
    )


def configuration() -> dict:
    config = {
        "interval": float(os.environ.get("DD_BACKUP_INTERVAL_SECONDS", "21600")),
        "max_age": float(os.environ.get("DD_BACKUP_MAX_AGE_SECONDS", "28800")),
        "poll": float(os.environ.get("DD_BACKUP_POLL_SECONDS", "60")),
        "retry": float(os.environ.get("DD_BACKUP_RETRY_SECONDS", "300")),
        "heartbeat_age": float(os.environ.get("DD_BACKUP_HEARTBEAT_SECONDS", "180")),
        "keep": int(os.environ.get("DD_BACKUP_KEEP", "30")),
    }
    if (not all(math.isfinite(config[k]) and config[k] > 0
                for k in ("interval", "max_age", "poll", "retry", "heartbeat_age"))
            or config["max_age"] < config["interval"]
            or config["heartbeat_age"] < config["poll"] or config["keep"] < 2):
        raise ValueError("invalid_backup_configuration")
    return config


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["check"])
    parser.parse_args()
    directory, _ = configured_paths()
    try:
        report = read_report(directory)
        conf = configuration()
        health = report_health(report, time.time(), conf["max_age"], conf["heartbeat_age"])
    except (OSError, ValueError, TypeError, KeyError):
        health = {"healthy": False, "state": "status_invalid"}
    print(json.dumps(health))
    return 0 if health["healthy"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
