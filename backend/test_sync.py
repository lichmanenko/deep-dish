"""Sync and migration regressions on disposable SQLite databases."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


class SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        with patch.dict('os.environ', {'DD_DB': str(Path(temporary.name) / 'bootstrap.db')}):
            import server
        cls.server = server
        cls.addClassCleanup(server._log_handler.close)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.database = Path(temporary.name) / 'current.db'
        self.enterContext(patch.object(self.server, 'DB_PATH', str(self.database)))
        self.enterContext(patch.object(self.server, 'now_ms', return_value=10_000))

    def register_family(self):
        server = self.server
        first = server.register(server.RegisterIn(nickname='A'))
        second = server.register(server.RegisterIn(nickname='B', adminToken=first['token']))
        return [server.auth('Bearer ' + user['token']) for user in (first, second)]

    def exchange(self, user, changes=(), **cursor):
        return self.server.sync(self.server.SyncIn(changes=list(changes), **cursor), user)

    @staticmethod
    def change(kind, identity, updated=9000, **body):
        return {'kind': kind, 'body': {'id': identity, 'updatedAt': updated, **body}}

    def test_large_push_keeps_last_record_and_legacy_cursor_can_read_batch(self):
        self.server.init_db()
        user, _ = self.register_family()
        records = [self.change('entries', f'entry-{i:05}') for i in range(5001)]
        first = self.exchange(user, records, cursor={})
        second = self.exchange(user, cursor=first['cursor'])
        self.assertEqual(first['applied'], 5001)
        self.assertEqual(len(first['changes']), 5000)
        self.assertTrue(first['hasMore'])
        self.assertEqual([item['body']['id'] for item in second['changes']], ['entry-05000'])
        self.assertFalse(second['hasMore'])
        self.assertEqual(self.exchange(user, cursor=second['cursor'])['changes'], [])
        legacy = self.exchange(user, since=0)
        self.assertEqual(len(legacy['changes']), 5001)
        self.assertFalse(legacy['hasMore'])

    def test_writer_after_empty_page_is_visible_in_same_clock_tick(self):
        self.server.init_db()
        user, _ = self.register_family()
        empty = self.exchange(user, cursor={})
        self.exchange(user, [self.change('entries', 'new-entry')])
        delta = self.exchange(user, cursor=empty['cursor'])
        self.assertEqual([item['body']['id'] for item in delta['changes']], ['new-entry'])
        legacy = self.exchange(user, since=empty['serverTime'])
        self.assertEqual([item['body']['id'] for item in legacy['changes']], ['new-entry'])

    def test_private_rows_keep_common_ids_after_existing_database_migration(self):
        self.server.init_db()
        alice, bob = self.register_family()
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute('DROP TABLE items')
            database.execute('''CREATE TABLE items (kind TEXT NOT NULL, id TEXT NOT NULL,
                owner TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                body TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id))''')
            body = {'id': 'slot-breakfast', 'defaultTime': '07:15', 'updatedAt': 100,
                    'ownerId': alice['userId']}
            database.execute('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)',
                             ('slots', 'slot-breakfast', alice['userId'], 100, 0, json.dumps(body), 100))
        self.server.init_db()
        for who, time in [(alice, '07:15'), (bob, '09:00')]:
            own_rows = [self.change('entries', 'local-entry', value=time),
                        self.change('dayNormas', 'ignored', date='2026-11-22', value=time),
                        self.change('slotMarks', 'same-date-and-slot', value=time)]
            if who == bob:
                own_rows.append(self.change('slots', 'slot-breakfast', defaultTime=time))
            self.exchange(who, own_rows)
        self.server.init_db()
        for who, time in [(alice, '07:15'), (bob, '09:00')]:
            entries = {row['kind']: row['body'] for row in self.exchange(who, cursor={})['changes']}
            self.assertEqual(entries['slots']['defaultTime'], time)
            for kind in ('entries', 'dayNormas', 'slotMarks'):
                self.assertEqual(entries[kind]['value'], time)
                self.assertEqual(entries[kind]['userId'], who['userId'])

    def test_catalog_tombstone_is_delivered_and_survives_repeated_old_record(self):
        self.server.init_db()
        alice, bob = self.register_family()
        old = self.change('foods', 'food', isPublic=True, name='Original')
        self.exchange(alice, [old])
        previous = self.exchange(bob, cursor={})
        self.exchange(alice, [self.change('foods', 'food', 9001, isPublic=True,
                                         name='Original', deletedAt=9001, delBy='user')])
        self.exchange(alice, [old, self.change('foods', 'food', 9999, isPublic=True)])
        received = self.exchange(bob, cursor=previous['cursor'])
        self.assertEqual(len(received['changes']), 1)
        self.assertEqual(received['changes'][0]['body']['deletedAt'], 9001)

    def test_legacy_accidental_deletion_keeps_the_canonical_catalog_item(self):
        self.server.init_db()
        user, _ = self.register_family()
        self.exchange(user, [self.change('foods', 'food', isPublic=True, name='Original')])
        replay = self.change('foods', 'food', 9001, isPublic=True, name='Old local copy', deletedAt=9001)
        received = self.exchange(user, [replay])
        self.assertEqual(received['changes'][0]['body']['name'], 'Original')
        self.assertIsNone(received['changes'][0]['body']['deletedAt'])

    def test_hidden_catalog_rows_do_not_consume_another_users_page(self):
        self.server.init_db()
        alice, bob = self.register_family()
        hidden = [self.change('foods', 'private', isPublic=False), self.change('foods', 'null', isPublic=None)]
        self.exchange(alice, hidden + [self.change('foods', 'public', isPublic=True)])
        with patch.object(self.server, 'SYNC_PAGE_SIZE', 1):
            out = self.exchange(bob, cursor={})
        self.assertEqual([row['body']['id'] for row in out['changes']], ['public'])
        self.assertFalse(out['hasMore'])

    def test_batch_reports_rejections_without_dropping_other_changes(self):
        self.server.init_db()
        user, _ = self.register_family()
        valid = self.change('entries', 'entry')
        invalid = self.change('entries', 'invalid', updated='unusable')
        self.assertEqual(self.exchange(user, [valid, invalid, valid])['results'],
                         ['applied', 'rejected', 'current'])

    def test_current_base_allows_edit_when_client_clock_goes_back(self):
        self.server.init_db()
        user, _ = self.register_family()
        self.exchange(user, [self.change('entries', 'entry', 9500, grams=100)])
        edit = self.change('entries', 'entry', 9100, grams=150)
        edit['baseUpdated'] = 9500
        applied = self.exchange(user, [edit], pull=False, cursor={})
        self.assertEqual(applied['results'], ['applied'])
        self.assertGreater(applied['corrections'][0]['updated'], 9500)
        replay = self.exchange(user, [edit], pull=False, cursor={})
        self.assertEqual(replay['results'], ['current'])
        self.assertEqual(replay['corrections'][0]['body']['grams'], 150)

    def test_invitation_is_single_use_and_expires(self):
        self.server.init_db()
        owner, member = self.register_family()
        with self.assertRaises(self.server.HTTPException):
            self.server.create_invite(member)
        response = json.loads(self.server.create_invite(owner).body)
        invite = self.server.RegisterIn(nickname='New', inviteCode=response['code'])
        self.assertEqual(self.server.register(invite)['role'], 'member')
        with self.assertRaises(self.server.HTTPException):
            self.server.register(invite)
        expired = json.loads(self.server.create_invite(owner).body)
        with patch.object(self.server, 'now_ms', return_value=expired['expiresAt']):
            with self.assertRaises(self.server.HTTPException):
                self.server.register(self.server.RegisterIn(nickname='Late', inviteCode=expired['code']))


if __name__ == '__main__':
    unittest.main()
