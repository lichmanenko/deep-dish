"""HTTP integration on synthetic data; never contacts the NAS."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class ServerBackupIntegration(unittest.TestCase):
    def test_lifespan_backup_and_visible_failure_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            data.mkdir()
            with socket.socket() as available:
                available.bind(("127.0.0.1", 0))
                port = available.getsockname()[1]
            env = {k: v for k, v in os.environ.items()
                   if k.upper() in {"SYSTEMROOT", "PATH", "TEMP", "TMP", "APPDATA",
                                     "LOCALAPPDATA", "USERPROFILE", "LANG"}}
            env.update(
                DD_DB=str(data / "deepdish.db"),
                DD_BACKUP_DIR=str(data / "backups"),
                DD_BACKUP_STAGING_DIR=str(root / "stage"),
                DD_BACKUP_INTERVAL_SECONDS="0.3",
                DD_BACKUP_MAX_AGE_SECONDS="2",
                DD_BACKUP_POLL_SECONDS="0.05",
                DD_BACKUP_RETRY_SECONDS="0.1",
                DD_BACKUP_HEARTBEAT_SECONDS="0.4",
                DD_BACKUP_KEEP="3",
            )
            process = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "server:app",
                 "--host", "127.0.0.1", "--port", str(port)],
                cwd=Path(__file__).parent, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            def request(path, payload=None, token=None):
                body = None if payload is None else json.dumps(payload).encode()
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}" + path, data=body, headers=headers)
                try:
                    response = urllib.request.urlopen(req, timeout=2)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    return response.code, json.load(response)
            def wait(predicate):
                deadline = time.monotonic() + 8
                last = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.fail("Synthetic server exited: " + process.stdout.read().decode(errors="replace"))
                    try:
                        last = predicate()
                        if last:
                            return
                    except (OSError, ValueError):
                        pass
                    time.sleep(.03)
                self.fail("Synthetic condition timed out")
            try:
                wait(lambda: request("/backup-healthz")[0] == 200)
                code, liveness = request("/healthz")
                self.assertEqual(code, 200)
                self.assertTrue(liveness["ok"])
                self.assertTrue(liveness["backup"]["healthy"])
                _, member = request("/register", {"nickname": "Synthetic"})
                token = member["token"]
                code, synced = request("/sync", {"since": 0, "changes": [], "events": []}, token)
                self.assertEqual(code, 200)
                self.assertIn("serverTime", synced)
                def user_snapshot_ready():
                    report = json.loads((data / "backups" / "backup-status.json").read_text())
                    snapshot = data / "backups" / report["snapshot"]
                    with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro&immutable=1", uri=True)) as restored:
                        return restored.execute("SELECT count(*) FROM users").fetchone()[0] == 1
                wait(user_snapshot_ready)
                report = json.loads((data / "backups" / "backup-status.json").read_text())
                snapshot = data / "backups" / report["snapshot"]
                self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), report["snapshot_sha256"])
                self.assertNotIn(token, json.dumps(request("/backup-healthz")[1]))
                hidden = data / "temporarily-hidden.db"
                (data / "deepdish.db").rename(hidden)
                wait(lambda: request("/backup-healthz")[0] == 503)
                self.assertTrue(request("/healthz")[1]["ok"])
                self.assertEqual(request("/backup-healthz")[1]["error_code"], "source_missing")
                hidden.rename(data / "deepdish.db")
                wait(lambda: request("/backup-healthz")[0] == 200)
            finally:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
