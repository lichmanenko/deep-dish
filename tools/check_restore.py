"""Verify a restored snapshot and run the current migration on a disposable copy."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from tempfile import TemporaryDirectory


def inspect_snapshot(path: Path) -> tuple[dict, list[str]]:
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as database:
        if database.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite quick_check failed')
        if database.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign_key_check failed')
        items = database.execute('SELECT kind, COUNT(*) FROM items GROUP BY kind')
        counts = {
            'items': dict(items),
            'users': database.execute('SELECT COUNT(*) FROM users').fetchone()[0],
            'events': database.execute('SELECT COUNT(*) FROM events').fetchone()[0],
        }
        key = [(position, name) for _, name, _, _, _, position in database.execute('PRAGMA table_info(items)') if position]
        return counts, [name for _, name in sorted(key)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, help='Pair manifest (.db.json) restored from the backup target')
    parser.add_argument('--scratch', type=Path, required=True, help='Separate directory for a disposable migration copy')
    args = parser.parse_args()
    manifest = args.manifest.resolve(strict=True)
    if not manifest.name.endswith('.db.json'):
        raise SystemExit('Expected a snapshot manifest ending in .db.json')
    snapshot = manifest.with_suffix('')
    meta = json.loads(manifest.read_text(encoding='utf-8'))
    if meta['snapshot'] != snapshot.name or meta['snapshot_bytes'] != snapshot.stat().st_size:
        raise SystemExit('Snapshot name or size disagrees with the manifest')
    with snapshot.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != meta['snapshot_sha256']:
            raise SystemExit('Snapshot SHA-256 does not match the manifest')

    counts_before, key_before = inspect_snapshot(snapshot)
    backend = Path(__file__).resolve().parents[1] / 'backend'
    with TemporaryDirectory(prefix='deepdish-migration-', dir=args.scratch.resolve(strict=True)) as scratch:
        temporary = Path(scratch)
        migrated = temporary / 'copy.db'
        shutil.copyfile(snapshot, migrated)
        env = os.environ | {'DD_DB': str(migrated), 'DD_BACKUP_DIR': str(temporary / 'backups'),
                            'DD_BACKUP_STAGING_DIR': str(temporary / 'staging')}
        subprocess.run([sys.executable, '-c', 'import server'], cwd=backend, env=env, check=True)
        counts_after, key_after = inspect_snapshot(migrated)
        if counts_before != counts_after or key_after != ['kind', 'id', 'owner']:
            raise SystemExit('Migration changed record counts or left an unexpected primary key')

    print(json.dumps({'snapshot_integrity': 'ok', 'migration': 'ok', 'key_before': key_before,
                      'key_after': key_after, 'counts_preserved': True}))


if __name__ == '__main__':
    main()
