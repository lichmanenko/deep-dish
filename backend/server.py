# Deep Dish sync server: FastAPI + SQLite (WAL), один эндпоинт обмена POST /sync.
# Спецификация — SPEC.md §4–5: LWW по updatedAt, tombstone-удаления (очистка >90 дней),
# дневники приватные (фильтр по userId), каталог общий (isPublic), события метрик попутно.
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.environ.get('DD_DB', os.path.join(os.path.dirname(__file__), 'data', 'deepdish.db'))
TOMBSTONE_TTL_DAYS = 90

# kinds: общий каталог vs личные данные
PUBLIC_KINDS = {'foods', 'recipes'}
PRIVATE_KINDS = {'entries', 'weightLogs', 'dayNormas', 'slots', 'savedMeals', 'profiles'}
ALL_KINDS = PUBLIC_KINDS | PRIVATE_KINDS

app = FastAPI(title='Deep Dish sync', version='0.3.0')
# PWA живёт на GitHub Pages, сервер — дома: доступ управляется токеном, origins открыты
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=FULL')
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with db() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS users (
            userId TEXT PRIMARY KEY, nickname TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL DEFAULT 'member', createdAt INTEGER NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS items (
            kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL,
            updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
            PRIMARY KEY (kind, id))''')
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_updated ON items (kind, updated)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner, kind, updated)')
        c.execute('''CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, userId TEXT NOT NULL, ts INTEGER NOT NULL,
            name TEXT NOT NULL, props TEXT NOT NULL)''')


init_db()


def now_ms() -> int:
    return int(time.time() * 1000)


def auth(authorization: str = Header(default='')) -> sqlite3.Row:
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, 'нужен токен: Authorization: Bearer <token>')
    token = authorization[7:].strip()
    with db() as c:
        u = c.execute('SELECT * FROM users WHERE token = ?', (token,)).fetchone()
    if not u:
        raise HTTPException(401, 'токен не опознан')
    return u


class RegisterIn(BaseModel):
    nickname: str
    adminToken: str | None = None


class Change(BaseModel):
    kind: str
    body: dict[str, Any]


class SyncIn(BaseModel):
    since: int = 0
    changes: list[Change] = []
    events: list[dict[str, Any]] = []


@app.get('/healthz')
def healthz() -> dict[str, Any]:
    return {'ok': True, 'serverTime': now_ms()}


@app.post('/register')
def register(payload: RegisterIn) -> dict[str, Any]:
    nickname = payload.nickname.strip()[:40]
    if not nickname:
        raise HTTPException(400, 'псевдоним пуст')
    user_id = secrets.token_hex(8)
    token = secrets.token_urlsafe(24)
    with db() as c:
        n = c.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
        role = 'admin' if n == 0 else 'member'  # первый зарегистрировавшийся — admin
        if role == 'member' and not payload.adminToken:
            raise HTTPException(403, 'регистрацию новых участников включает администратор (adminToken)')
        if role == 'member':
            admin = c.execute("SELECT * FROM users WHERE token = ? AND role = 'admin'", (payload.adminToken,)).fetchone()
            if not admin:
                raise HTTPException(403, 'adminToken не опознан')
        c.execute('INSERT INTO users (userId, nickname, token, role, createdAt) VALUES (?,?,?,?,?)',
                  (user_id, nickname, token, role, now_ms()))
    return {'userId': user_id, 'token': token, 'role': role}


@app.get('/admin/users')
def admin_users(user: sqlite3.Row = Depends(auth)) -> list[dict[str, Any]]:
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    with db() as c:
        rows = c.execute('SELECT userId, nickname, role, createdAt FROM users ORDER BY createdAt').fetchall()
    return [dict(r) for r in rows]


@app.post('/sync')
def sync(payload: SyncIn, user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    uid = user['userId']
    server_now = now_ms()
    applied = 0
    rejected = 0

    with db() as c:
        # 1) применить входящие изменения (LWW по updated; своё только)
        for ch in payload.changes:
            if ch.kind not in ALL_KINDS:
                rejected += 1
                continue
            body = ch.body or {}
            cid = str(body.get('id') or body.get('userId') or '')
            if ch.kind == 'profiles':
                cid = uid  # профиль один на юзера, ключ — userId
                body['userId'] = uid
            if not cid:
                rejected += 1
                continue
            owner = str(body.get('ownerId') or uid)
            if ch.kind in PUBLIC_KINDS:
                body['ownerId'] = owner  # каталог: автор = ownerId (может быть system у форков)
                if owner != uid and owner != 'system' and not body.get('isPublic', True):
                    rejected += 1
                    continue
            else:
                body['ownerId'] = uid  # личное всегда своё
            updated = int(body.get('updatedAt') or 0)
            if not updated:
                rejected += 1
                continue
            deleted = 1 if body.get('deletedAt') else 0
            cur = c.execute('SELECT updated FROM items WHERE kind = ? AND id = ?', (ch.kind, cid)).fetchone()
            if cur and cur['updated'] >= updated:
                continue  # сервер новее или тот же — клиент получит серверную версию
            c.execute('''INSERT INTO items (kind, id, owner, updated, deleted, body)
                         VALUES (?,?,?,?,?,?)
                         ON CONFLICT (kind, id) DO UPDATE SET
                           owner = excluded.owner, updated = excluded.updated,
                           deleted = excluded.deleted, body = excluded.body''',
                      (ch.kind, cid, uid if ch.kind not in PUBLIC_KINDS else owner, updated, deleted, json.dumps(body, ensure_ascii=False)))
            applied += 1

        # 2) события метрик (идемпотентно по id)
        for ev in payload.events[:500]:
            try:
                c.execute('INSERT OR IGNORE INTO events (id, userId, ts, name, props) VALUES (?,?,?,?,?)',
                          (str(ev.get('id')), uid, int(ev.get('ts') or 0), str(ev.get('name') or '?'),
                           json.dumps(ev.get('props') or {}, ensure_ascii=False)))
            except Exception:
                pass

        # 3) отдать изменения новее since: личное — только своё, каталог — живой общий
        rows = c.execute('''SELECT kind, body, updated FROM items
                            WHERE updated > ? AND (owner = ? OR (kind IN ('foods','recipes') AND deleted = 0))
                            ORDER BY updated LIMIT 5000''',
                         (payload.since, uid)).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            body = json.loads(r['body'])
            if r['kind'] in PUBLIC_KINDS and not body.get('isPublic', True) and body.get('ownerId') != uid:
                continue  # чужие черновики каталога не рассылаем
            out.append({'kind': r['kind'], 'body': body, 'updated': r['updated']})

        # 4) чистка старых tombstone (не чаще раза в час — по факту запроса, дёшево на SQLite)
        c.execute('DELETE FROM items WHERE deleted = 1 AND updated < ?', (server_now - TOMBSTONE_TTL_DAYS * 86400000,))

    return {'changes': out, 'serverTime': server_now, 'applied': applied, 'rejected': rejected}
