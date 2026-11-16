from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from sqlite_backups import BackupManager, BackupFailure, read_report, report_health, configuration


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "data" / "live.db"
        self.source.parent.mkdir()
        self.writer = sqlite3.connect(self.source)
        self.writer.execute("PRAGMA journal_mode=WAL")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
        self.writer.execute("INSERT INTO sample VALUES (1, 'synthetic')")
        self.writer.commit()
        self.now = 1800000000.0
        self.manager = BackupManager(
            self.source, self.root / "data" / "backups", self.root / "staging",
            interval=10, max_age=20, poll=.05, retry=1, heartbeat_age=1,
            keep=2, clock=lambda: self.now)

    def tearDown(self):
        self.manager.stop()
        self.writer.close()
        self.temp.cleanup()

    def snapshots(self):
        return sorted(self.manager.directory.glob("deepdish-*.db"))

    def test_wal_snapshot_is_valid_before_atomic_publication(self):
        self.assertTrue(Path(str(self.source) + "-wal").exists())
        validate = self.manager._validate
        observed = []
        def inspect(temporary):
            self.assertFalse(self.snapshots())
            self.assertEqual(temporary.parent, self.root / "staging")
            validate(temporary)
            observed.append(True)
        with patch.object(self.manager, "_validate", side_effect=inspect):
            self.assertTrue(self.manager.tick(force=True))
        snapshot = self.snapshots()[0]
        with closing(sqlite3.connect(snapshot)) as restored:
            self.assertEqual(restored.execute("SELECT value FROM sample").fetchall(), [("synthetic",)])
        manifest = json.loads(Path(str(snapshot) + ".json").read_text())
        self.assertEqual(manifest["snapshot_sha256"], hashlib.sha256(snapshot.read_bytes()).hexdigest())
        self.assertEqual(manifest["quick_check"], "ok")
        self.assertTrue(self.manager.health()["healthy"])
        self.assertTrue(observed)
        self.assertEqual(list(self.manager.staging.glob("*.tmp")), [])

    def test_incomplete_snapshot_never_replaces_previous_generation(self):
        self.manager.tick(force=True)
        before = self.snapshots()
        def incomplete(path):
            path.write_bytes(b"not a SQLite database")
        self.now += 11
        with patch.object(self.manager, "_vacuum", side_effect=incomplete):
            self.assertFalse(self.manager.tick())
        self.assertEqual(before, self.snapshots())
        self.assertEqual(self.manager.health()["error_code"], "snapshot_invalid")
        self.assertFalse(self.manager.health()["healthy"])
        self.assertFalse(list(self.manager.staging.glob("*.tmp")))

    def test_cross_mount_publish_failure_does_not_copy_partial_data(self):
        self.manager.tick(force=True)
        before = self.snapshots()
        original_replace = os.replace
        def fail_database(source, dest):
            if str(dest).endswith(".db"):
                raise OSError("simulated cross-device rename")
            return original_replace(source, dest)
        self.now += 11
        with patch("sqlite_backups.os.replace", side_effect=fail_database):
            self.assertFalse(self.manager.tick())
        self.assertEqual(before, self.snapshots())
        self.assertEqual(self.manager.health()["error_code"], "publish_failed")

    def test_manifest_failure_preserves_previous_snapshot(self):
        self.manager.tick(force=True)
        before = self.snapshots()
        original_replace = os.replace
        def fail_manifest(source, dest):
            if str(dest).endswith(".db.json"):
                raise OSError("simulated disk full")
            return original_replace(source, dest)
        self.now += 11
        with patch("sqlite_backups.os.replace", side_effect=fail_manifest):
            self.assertFalse(self.manager.tick())
        self.assertEqual(before, self.snapshots())
        self.assertFalse(list(self.manager.staging.glob("*.tmp")))

    def test_rotation_follows_success_and_preserves_unrelated_files(self):
        self.manager.tick(force=True)
        unrelated = self.manager.directory / "unrelated.db"
        unrelated.write_bytes(b"leave untouched")
        self.now += 11
        self.manager.tick()
        previous = self.snapshots()
        self.now += 11
        with patch.object(self.manager, "_vacuum", side_effect=BackupFailure("snapshot_failed")):
            self.manager.tick()
        self.assertEqual(previous, self.snapshots())
        self.now += 2
        self.manager.tick()
        self.assertEqual(len(self.snapshots()), 2)
        self.assertTrue(unrelated.exists())
        self.assertTrue(self.manager.health()["healthy"])
        self.assertEqual(len(list(self.manager.directory.glob("deepdish-*.db.json"))), 2)

    def test_stale_worker_and_stale_snapshot_are_separate(self):
        self.manager.tick(force=True)
        self.now += 2
        self.assertEqual(self.manager.health()["state"], "worker_stale")
        self.manager.tick()
        self.assertTrue(self.manager.health()["healthy"])
        self.now += 21
        report = read_report(self.manager.directory)
        report["checked_at"] = self.now
        self.assertEqual(report_health(report, self.now, 20, 1)["state"], "stale")

    def test_missing_source_and_recovery_keep_last_success(self):
        self.manager.tick(force=True)
        saved = self.manager.health()["last_success_at"]
        self.writer.close()
        self.writer = sqlite3.connect(":memory:")
        hidden = self.source.with_suffix(".hidden")
        self.source.rename(hidden)
        self.now += 11
        self.manager.tick()
        self.assertEqual(self.manager.health()["error_code"], "source_missing")
        self.assertEqual(self.manager.health()["last_success_at"], saved)
        hidden.rename(self.source)
        self.now += 2
        self.manager.tick()
        self.assertTrue(self.manager.health()["healthy"])

    def test_status_write_failure_is_visible_and_recoverable(self):
        self.manager.tick(force=True)
        original_replace = os.replace
        def fail_status(source, dest):
            if str(dest).endswith("backup-status.json"):
                raise OSError("simulated full status destination")
            return original_replace(source, dest)
        with patch("sqlite_backups.os.replace", side_effect=fail_status):
            self.manager.tick()
        self.assertFalse(self.manager.health()["healthy"])
        self.assertEqual(self.manager.health()["error_code"], "status_write_failed")
        self.manager.tick()
        self.assertTrue(self.manager.health()["healthy"])

    def test_malformed_and_path_traversal_status_rejected(self):
        self.manager.tick(force=True)
        path = self.manager.directory / "backup-status.json"
        path.write_text("[]")
        with self.assertRaises(ValueError):
            read_report(self.manager.directory)
        path.write_text(json.dumps({"schema": 1, "generator": "1", "snapshot": "../live.db"}))
        with self.assertRaises(ValueError):
            read_report(self.manager.directory)

    def test_cli_detects_dead_worker_without_http_or_tls_bypass(self):
        self.manager.tick(force=True)
        report_path = self.manager.directory / "backup-status.json"
        report = json.loads(report_path.read_text())
        report["checked_at"] = time.time() - 1000
        report["last_success_at"] = time.time()
        report_path.write_text(json.dumps(report))
        env = dict(os.environ, DD_BACKUP_DIR=str(self.manager.directory))
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("sqlite_backups.py")), "check"],
            env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["state"], "worker_stale")

    def test_worker_runs_without_sync_and_stops_cleanly(self):
        manager = BackupManager(
            self.source, self.root / "worker" / "backups", self.root / "worker" / "stage",
            interval=.15, max_age=1, poll=.03, retry=.03, heartbeat_age=.2, keep=3)
        manager.start()
        try:
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if len(list(manager.directory.glob("deepdish-*.db"))) >= 2:
                    break
                time.sleep(.02)
            self.assertGreaterEqual(len(list(manager.directory.glob("deepdish-*.db"))), 2)
            self.assertTrue(manager.health()["healthy"])
        finally:
            manager.stop()
        self.assertFalse(manager._thread.is_alive())


    def test_restart_preserves_recent_valid_generation_without_rotation(self):
        self.manager.tick(force=True)
        before = self.snapshots()
        restarted = BackupManager(self.source, self.manager.directory, self.manager.staging,
                                  interval=10, max_age=20, poll=.05,
                                  heartbeat_age=1, clock=lambda: self.now)
        self.assertFalse(restarted.tick())
        self.assertEqual(before, self.snapshots())
        self.assertTrue(restarted.health()["healthy"])

    def test_published_snapshot_disappearance_is_detected_and_repaired(self):
        self.manager.tick(force=True)
        self.snapshots()[0].unlink()
        self.assertFalse(self.manager.health()["healthy"])
        self.now += 2
        self.manager.tick()
        self.assertTrue(self.manager.health()["healthy"])

    def test_new_generation_survives_backwards_clock_rotation(self):
        self.manager.tick(force=True)
        self.now += 11
        self.manager.tick()
        self.now -= 100
        self.manager.tick(force=True)
        report = read_report(self.manager.directory)
        self.assertTrue((self.manager.directory / report["snapshot"]).exists())
        self.assertEqual(len(self.snapshots()), 2)

    def test_orphan_staging_cleanup_is_limited_to_owned_names(self):
        self.manager.staging.mkdir()
        orphan = self.manager.staging / ("a" * 32 + ".sqlite.tmp")
        unrelated = self.manager.staging / "owner-note.txt"
        orphan.write_bytes(b"incomplete")
        unrelated.write_text("retain")
        self.manager.tick(force=True)
        self.assertFalse(orphan.exists())
        self.assertTrue(unrelated.exists())

    def test_source_inside_rotated_directory_is_rejected(self):
        with self.assertRaises(ValueError):
            BackupManager(self.source, self.source.parent, self.root / "stage")

    def test_environment_cannot_disable_freshness_with_nan(self):
        with patch.dict(os.environ, {"DD_BACKUP_MAX_AGE_SECONDS": "nan"}):
            with self.assertRaises(ValueError):
                configuration()

    def test_invalid_configuration_rejected(self):
        with self.assertRaises(ValueError):
            BackupManager(self.source, self.root / "ready", self.root / "ready" / "tmp")
        with self.assertRaises(ValueError):
            BackupManager(self.source, self.root / "ready", self.root / "stage", max_age=1)


if __name__ == "__main__":
    unittest.main()
