# Deep Dish sync server: FastAPI + SQLite (WAL), один эндпоинт обмена POST /sync.
# Спецификация — SPEC.md §4–5: LWW по updatedAt, tombstone-удаления (очистка >90 дней),
# дневники приватные (фильтр по userId), каталог общий (isPublic), события метрик попутно.
import hashlib
import json
import logging
import logging.handlers
import os
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import date as calendar_date, datetime
from typing import Annotated, Any, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from sqlite_backups import BackupManager, configured_paths, configuration
from pydantic import BaseModel, Field

DB_PATH = os.path.abspath(os.environ.get('DD_DB', os.path.join(os.path.dirname(__file__), 'data', 'deepdish.db')))
TOMBSTONE_TTL_DAYS = 90

# v0.7.4: структурные логи в файл с ротацией (диагностика NAS вслепую стала невозможной)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
log = logging.getLogger('deepdish')
log.setLevel(logging.INFO)
_log_handler = logging.handlers.RotatingFileHandler(
    os.path.join(os.path.dirname(DB_PATH), 'server.log'),
    maxBytes=1_000_000, backupCount=3, encoding='utf-8')
_log_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
log.addHandler(_log_handler)

# Snapshots are independent of incoming sync requests.
_backup_dir, _backup_staging = configured_paths()
backup_manager = BackupManager(DB_PATH, _backup_dir, _backup_staging,
                               logger=log, **configuration())


@asynccontextmanager
async def lifespan(app: FastAPI):
    backup_manager.start()
    try:
        yield
    finally:
        backup_manager.stop()


# kinds: общий каталог vs личные данные
PUBLIC_KINDS = {'foods', 'recipes'}
PRIVATE_KINDS = {'entries', 'weightLogs', 'dayNormas', 'slotMarks', 'slots', 'savedMeals', 'profiles'}
FAMILY_KINDS = {'achievements'}  # v0.7.6: публичные записи семьи (достижения — факт известен всем)
ALL_KINDS = PUBLIC_KINDS | PRIVATE_KINDS | FAMILY_KINDS
SYNC_PAGE_SIZE = 5000
INVITE_LIFETIME_MS = 15 * 60 * 1000

app = FastAPI(title='Deep Dish sync', version='0.4.9', lifespan=lifespan)
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


def create_items_table(c: sqlite3.Connection) -> None:
    c.execute("""CREATE TABLE IF NOT EXISTS items (
        kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL,
        updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id, owner))""")


def init_db() -> None:
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute("""CREATE TABLE IF NOT EXISTS users (
            userId TEXT PRIMARY KEY, nickname TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL DEFAULT 'member', createdAt INTEGER NOT NULL, healthCode TEXT)""")
        create_items_table(c)
        cols = {r['name']: r['pk'] for r in c.execute('PRAGMA table_info(items)')}
        if not cols['owner']:
            # SQLite cannot extend a primary key in place. Keep the stored IDs and JSON bodies.
            old_applied = 'applied' if 'applied' in cols else 'updated'
            c.execute('ALTER TABLE items RENAME TO items_before_owner_scope')
            create_items_table(c)
            c.execute(f"""INSERT INTO items (kind, id, owner, updated, deleted, body, applied)
                          SELECT kind, id, owner, updated, deleted, body, {old_applied}
                          FROM items_before_owner_scope""")
            c.execute('DROP TABLE items_before_owner_scope')
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_updated ON items (kind, updated)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner, kind, updated)')
        c.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_items_shared_id ON items (kind, id)
                     WHERE kind IN ('foods','recipes','achievements','offcache')""")
        c.execute('CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT)')
        mark = c.execute("SELECT v FROM _meta WHERE k = 'applied_refresh'").fetchone()
        if not mark or mark['v'] != '2':
            c.execute("UPDATE items SET applied = ? WHERE kind != 'offcache'", (int(time.time() * 1000),))
            c.execute("INSERT OR REPLACE INTO _meta (k, v) VALUES ('applied_refresh', '2')")
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_cursor ON items (applied, kind, id, owner)')
        c.execute("""INSERT OR IGNORE INTO _meta (k, v)
                     SELECT 'sync_stamp', CAST(COALESCE(MAX(applied), 0) AS TEXT)
                     FROM items WHERE kind != 'offcache'""")
        c.execute("""CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, userId TEXT NOT NULL, ts INTEGER NOT NULL,
            name TEXT NOT NULL, props TEXT NOT NULL)""")
        c.execute('''CREATE TABLE IF NOT EXISTS invites (
            codeHash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)''')
        if not any(row['name'] == 'healthCode' for row in c.execute('PRAGMA table_info(users)')):
            c.execute('ALTER TABLE users ADD COLUMN healthCode TEXT')


init_db()


def now_ms() -> int:
    return int(time.time() * 1000)


def sync_stamp(c: sqlite3.Connection) -> int:
    previous = c.execute("SELECT v FROM _meta WHERE k = 'sync_stamp'").fetchone()
    return int(previous['v'])


def advance_sync_stamp(c: sqlite3.Connection, previous: int, wall_time: int) -> int:
    """Call while holding a write transaction so later writers sort after this exchange."""
    stamp = max(wall_time, previous + 1)
    c.execute("UPDATE _meta SET v = ? WHERE k = 'sync_stamp'", (str(stamp),))
    return stamp


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
    inviteCode: str | None = None


class Change(BaseModel):
    kind: str
    body: dict[str, Any]
    baseUpdated: int | None = Field(default=None, ge=0, le=2**53 - 1)


class PullCursor(BaseModel):
    applied: int = Field(default=0, ge=0, le=2**53 - 1)
    kind: str = ''
    id: str = ''
    owner: str = ''


class SyncIn(BaseModel):
    since: int = Field(default=0, ge=0, le=2**53 - 1)
    cursor: PullCursor | None = None
    pull: bool = True
    changes: list[Change] = Field(default_factory=list)
    events: list[dict[str, Any]] = Field(default_factory=list)
    client_now: int = 0  # часы устройства (телеметрия skew, v0.4.4)


@app.get('/healthz')
def healthz() -> dict[str, Any]:
    return {'ok': True, 'serverTime': now_ms(), 'backup': backup_manager.health()}


@app.get('/backup-healthz')
def backup_healthz():
    health = backup_manager.health()
    return JSONResponse(health, status_code=200 if health['healthy'] else 503)


@app.post('/register')
def register(payload: RegisterIn) -> dict[str, Any]:
    nickname = payload.nickname.strip()[:40]
    if not nickname:
        raise HTTPException(400, 'псевдоним пуст')
    user_id = secrets.token_hex(8)
    token = secrets.token_urlsafe(24)
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        n = c.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
        role = 'admin' if n == 0 else 'member'  # первый зарегистрировавшийся — admin
        if role == 'member':
            if payload.inviteCode:
                digest = hashlib.sha256(payload.inviteCode.strip().encode()).hexdigest()
                used = c.execute('DELETE FROM invites WHERE codeHash = ? AND expiresAt > ?', (digest, now_ms()))
                if used.rowcount != 1:
                    raise HTTPException(403, 'Код приглашения недействителен или уже использован.')
            else:
                # Older installed clients still send adminToken during the transition.
                admin = c.execute("SELECT 1 FROM users WHERE token = ? AND role = 'admin'", (payload.adminToken,)).fetchone()
                if not admin:
                    raise HTTPException(403, 'Для подключения нужен код приглашения администратора.')
        c.execute('INSERT INTO users (userId, nickname, token, role, createdAt) VALUES (?,?,?,?,?)',
                  (user_id, nickname, token, role, now_ms()))
    log.info('register nick=%s role=%s', nickname, role)
    return {'userId': user_id, 'token': token, 'role': role}


@app.post('/admin/invite')
def create_invite(user: sqlite3.Row = Depends(auth)) -> JSONResponse:
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    code = secrets.token_urlsafe(24)
    digest = hashlib.sha256(code.encode()).hexdigest()
    now = now_ms()
    expiry = now + INVITE_LIFETIME_MS
    with db() as c:
        c.execute('DELETE FROM invites WHERE expiresAt <= ?', (now,))
        c.execute('INSERT INTO invites (codeHash, expiresAt) VALUES (?, ?)', (digest, expiry))
    return JSONResponse({'code': code, 'expiresAt': expiry}, headers={'Cache-Control': 'no-store'})


@app.get('/admin/users')
def admin_users(user: sqlite3.Row = Depends(auth)) -> list[dict[str, Any]]:
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    with db() as c:
        rows = c.execute('SELECT userId, nickname, role, createdAt FROM users ORDER BY createdAt').fetchall()
    return [dict(r) for r in rows]


@app.get('/admin/metrics')
def admin_metrics(days: int = 30, user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    """Агрегаты для витрины метрик (админ; SPEC §8): вовлечённость, регулярность,
    использование функций, баннеры, офлайн-доля. Только counts — без содержимого дневника."""
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    days = max(1, min(days, 90))
    since = now_ms() - days * 86400000
    with db() as c:
        def rows(q: str, args: tuple = ()) -> list[dict]:
            return [dict(r) for r in c.execute(q, args).fetchall()]

        users = rows('SELECT userId, nickname FROM users')
        nick = {u['userId']: u['nickname'] for u in users}

        # события по типам и юзерам
        ev = rows('SELECT userId, name, ts, props FROM events WHERE ts >= ?', (since,))
        by_user: dict[str, dict[str, int]] = {u['userId']: {} for u in users}
        online_t = online_f = 0
        banner_shown = banner_dismiss = 0
        for e in ev:
            u = by_user.setdefault(e['userId'], {})
            u[e['name']] = u.get(e['name'], 0) + 1
            if e['name'] == 'app_open':
                try:
                    props = json.loads(e['props'] or '{}')
                except (TypeError, ValueError):
                    continue
                online = props.get('online') if isinstance(props, dict) else None
                if online is True:
                    online_t += 1
                elif online is False:
                    online_f += 1
            if e['name'] == 'banner_shown':
                banner_shown += 1
            if e['name'] in ('banner_dismissed', 'banner_x'):
                banner_dismiss += 1

        # вовлечённость: дни с записями еды (по датам записей), по юзерам; + прошлое окно для сравнения
        from datetime import date as _d2, timedelta as _td2
        since_day2 = (_d2.today() - _td2(days=days)).isoformat()
        prev_day2 = (_d2.today() - _td2(days=2 * days)).isoformat()
        active_days = rows(
            "SELECT owner, COUNT(DISTINCT json_extract(body,'$.date')) AS d FROM items "
            "WHERE kind='entries' AND deleted = 0 AND json_extract(body,'$.date') >= ? GROUP BY owner", (since_day2,))
        prev_days = rows(
            "SELECT owner, COUNT(DISTINCT json_extract(body,'$.date')) AS d FROM items "
            "WHERE kind='entries' AND deleted = 0 AND json_extract(body,'$.date') >= ? AND json_extract(body,'$.date') < ? GROUP BY owner",
            (prev_day2, since_day2))
        entries_cnt = rows(
            "SELECT owner, COUNT(*) AS n FROM items WHERE kind='entries' AND deleted = 0 AND json_extract(body,'$.date') >= ? GROUP BY owner", (since_day2,))

        # записи по дням (для графика, все юзеры вместе)
        per_day = rows(
            "SELECT json_extract(body,'$.date') AS day, COUNT(*) AS n FROM items "
            "WHERE kind='entries' AND deleted = 0 AND json_extract(body,'$.date') >= ? GROUP BY day ORDER BY day", (since_day2,))

        # тренд веса каждого юзера за 60 дней (для витрины: «−0,4 кг/нед»)
        # Д3(ревью): фильтр по дате взвешивания, не по времени правки —
        # импортированные давние веса не должны попадать в «последние 60 дней»
        from datetime import date as _d, timedelta as _td
        since_day = (_d.today() - _td(days=60)).isoformat()
        weight_trend = {}
        for r in c.execute(
                "SELECT owner, json_extract(body,'$.date') AS day, json_extract(body,'$.weightKg') AS kg FROM items "
                "WHERE kind='weightLogs' AND deleted = 0 AND json_extract(body,'$.date') >= ? ORDER BY day", (since_day,)):
            weight_trend.setdefault(r['owner'], []).append((r['day'], r['kg']))
        def slope_pw(points):
            if len(points) < 2:
                return None
            import datetime
            t0 = datetime.date.fromisoformat(points[0][0]).toordinal()
            xs = [datetime.date.fromisoformat(d).toordinal() - t0 for d, _ in points]
            ys = [kg for _, kg in points]
            n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
            num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            den = sum((x - mx) ** 2 for x in xs)
            if den == 0:
                return None
            return round((num / den) * 7, 2)  # кг/нед

        out_users = []
        for u in users:
            uid = u['userId']
            out_users.append({
                'nickname': u['nickname'],
                'activeDays': next((a['d'] for a in active_days if a['owner'] == uid), 0),
                'prevDays': next((a['d'] for a in prev_days if a['owner'] == uid), 0),
                'entries': next((e['n'] for e in entries_cnt if e['owner'] == uid), 0),
                'appOpens': by_user.get(uid, {}).get('app_open', 0),
                'topEvents': sorted(by_user.get(uid, {}).items(), key=lambda kv: -kv[1])[:6],
                'weightPw': slope_pw(weight_trend.get(uid, [])),
            })
        return {
            'days': days,
            'users': out_users,
            'perDay': [{'day': r['day'], 'n': r['n']} for r in per_day],
            'sessions': {'online': online_t, 'offline': online_f},
            'banners': {'shown': banner_shown, 'dismissed': banner_dismiss},
        }


@app.get('/admin/telemetry')
def admin_telemetry(since: int = 0, limit: int = 200,
                    user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    """Синк-обсерваторность (v0.4.4, В., 26.10): телеметрия клиентов — события синка/ошибок/часов
    + последние исходы по каждому пользователю. Только для администратора."""
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    with db() as c:
        names = ('sync_result', 'sync_fail', 'clock_skew', 'client_error')
        q = ', '.join('?' * len(names))
        evs = c.execute(f"SELECT ts, userId, name, props FROM events WHERE ts > ? AND name IN ({q}) ORDER BY ts DESC LIMIT ?",
                        (since, *names, min(limit, 1000))).fetchall()
        users = c.execute("SELECT userId, nickname FROM users").fetchall()
        nick = {u['userId']: u['nickname'] for u in users}
        # последний sync_result каждого
        def safe_props(raw):
            p = json.loads(raw or '{}')
            if isinstance(p, str):  # двойная сериализация (баг синка, пофикшен v0.4.5)
                try: p = json.loads(p)
                except Exception: p = {}
            return p if isinstance(p, dict) else {}

        latest: dict[str, Any] = {}
        for r in c.execute("SELECT ts, userId, props FROM events WHERE name = 'sync_result' ORDER BY ts DESC").fetchall():
            if r['userId'] in latest:
                continue
            latest[r['userId']] = {'nick': nick.get(r['userId']), 'ts': r['ts'], **safe_props(r['props'])}
        return {'events': [{'ts': r['ts'], 'nick': nick.get(r['userId']), 'name': r['name'],
                            'props': safe_props(r['props'])} for r in evs],
                'latestByUser': latest}


@app.post('/admin/push-catalog')
def admin_push_catalog(user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    """Админ: перезаморозить applied всех продуктов/рецептов → все члены семьи
    получат свежий каталог при следующем синке (В., 09.11: «отправить каталог всем»)."""
    if user['role'] != 'admin':
        raise HTTPException(403, 'только администратор')
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        stamp = advance_sync_stamp(c, sync_stamp(c), now_ms())
        cur = c.execute("UPDATE items SET applied = ? WHERE kind IN ('foods','recipes') AND deleted = 0", (stamp,))
        n = cur.rowcount
        log.info('push_catalog user=%s nick=%s applied_refreshed=%d', user['userId'], user['nickname'], n)
    return {'ok': True, 'applied': n}


@app.get('/off/search')
def off_search(q: str, user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    """Прокси поиска Open Food Facts: браузеру напрямую мешает CORS/нестабильность,
    сервер ходит свободно. Кэш 10 минут."""
    import urllib.request
    q = (q or '').strip()[:60]
    if len(q) < 3:
        return {'products': []}
    cache_key = 'off_' + q.lower()
    with db() as c:
        row = c.execute('SELECT body FROM items WHERE kind = ? AND id = ?', ('offcache', cache_key)).fetchone()
        if row and now_ms() - json.loads(row['body']).get('ts', 0) < 10 * 60 * 1000:
            return json.loads(row['body'])['payload']
    url = ('https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + urllib.parse.quote(q)
           + '&search_simple=1&action=process&json=1&page_size=10'
           + '&fields=code,product_name,product_name_ru,generic_name,brands,nutriments')
    req = urllib.request.Request(url, headers={'User-Agent': 'DeepDish-sync/0.4 (family tracker; github.com/lichmanenko)'})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        raise HTTPException(502, f'OFF недоступен: {e}')
    # не-русский шум: кириллический запрос -> только русская кириллица
    # (выбраковываем сербские ђ ћ џ љ њ ј и украинские ї є ґ; приоритет — товары с EAN 460-469 = Россия)
    SRB = set('ђћџљњј')
    UKR = set('їєґ')
    cyr_query = any('а' <= ch.lower() <= 'я' or ch.lower() in 'ё' for ch in q)

    def ru_ok(name: str) -> bool:
        if not cyr_query:
            return True
        nl = name.lower()
        if any(ch in SRB or ch in UKR for ch in nl):
            return False
        return any('а' <= ch <= 'я' or ch == 'ё' for ch in nl)

    hits = []
    for pr in (data.get('products') or [])[:10]:
        n = pr.get('nutriments') or {}
        kcal = n.get('energy-kcal_100g')
        if kcal is None and n.get('energy_100g') is not None:
            try:
                kcal = round(float(n['energy_100g']) / 4.184)
            except Exception:
                kcal = None
        name = (pr.get('product_name_ru') or pr.get('product_name') or pr.get('generic_name') or '').strip()
        if not name or not kcal or not ru_ok(name):
            continue
        hits.append({
            'id': str(pr.get('code') or ''),
            'name': name[:60],
            'brand': (pr.get('brands') or '').split(',')[0].strip()[:30] or None,
            'kcal': round(float(kcal)),
            'p': round(float(n.get('proteins_100g') or 0), 1),
            'f': round(float(n.get('fat_100g') or 0), 1),
            'c': round(float(n.get('carbohydrates_100g') or 0), 1),
        })
        if len(hits) >= 8:
            break
    if cyr_query and hits:
        ru_ean = [h for h in hits if h['id'].startswith('46')]
        if ru_ean:
            hits = ru_ean  # российская выдача; если пусто — оставляем кириллическую как есть
    payload = {'products': hits}
    with db() as c:
        c.execute('INSERT INTO items (kind, id, owner, updated, deleted, body) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET updated = excluded.updated, body = excluded.body',
                  ('offcache', cache_key, user['userId'], now_ms(), 0,
                   json.dumps({'ts': now_ms(), 'payload': payload}, ensure_ascii=False)))
    return payload


# ── Мост Apple Health (M3): шорткат iOS ходит с коротким кодом (не с токеном) ──
CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'  # без похожих 0/O/1/I


def deleted_flag(r: sqlite3.Row) -> bool:
    return bool(r['deleted'])


def auth_code(code: str) -> sqlite3.Row:
    code = (code or '').strip().upper()
    if not code:
        raise HTTPException(401, 'нужен код моста')
    with db() as c:
        u = c.execute('SELECT * FROM users WHERE healthCode = ?', (code,)).fetchone()
    if not u:
        raise HTTPException(401, 'код моста не опознан')
    return u


class CodeIn(BaseModel):
    reset: bool = False


@app.post('/health/code')
def health_code(payload: CodeIn | None = None, user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    reset = bool(payload and payload.reset)
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        cur = c.execute('SELECT healthCode FROM users WHERE userId = ?', (user['userId'],)).fetchone()['healthCode']
        if reset or not cur:
            for _ in range(5):
                code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(10))
                if not c.execute('SELECT 1 FROM users WHERE healthCode = ?', (code,)).fetchone():
                    c.execute('UPDATE users SET healthCode = ? WHERE userId = ?', (code, user['userId']))
                    cur = code
                    break
    return {'code': cur}



# ── мини-мост v2 (В., 25.10: сборка шортката — боль) ─────────────────────────
# Shortcuts сериализует дату в JSON по-разному в зависимости от версии/локали;
# принимаем все известные формы и приводим к YYYY-MM-DD.
_DATE_FORMATS = [
    '%Y-%m-%d',
    '%Y-%m-%d %H:%M:%S',
    '%Y-%m-%dT%H:%M:%S',
    '%Y-%m-%dT%H:%M:%S%z',
    '%Y-%m-%d %H:%M:%S %z',
    '%d.%m.%Y %H:%M',
    '%d.%m.%Y %H:%M:%S',
    '%d.%m.%Y, %H:%M',
    '%d.%m.%Y, %H:%M:%S',
    '%d %B %Y г. в %H:%M',
    '%d %B %Y г., %H:%M',
    '%d %B %Y at %H:%M',
    '%B %d, %Y at %I:%M %p',
    '%d %b %Y %H:%M:%S',
]
_MONTHS_RU = {'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
              'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12}


def parse_date_flex(raw: Any) -> str | None:
    """Любая сериализация даты Shortcuts → YYYY-MM-DD (или None)."""
    import re as _re
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        ts = float(raw)
        if ts > 1e12: ts /= 1000.0          # миллисекунды
        if 946684800 < ts < 4102444800:     # 2000..2100
            import datetime as _dt
            return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).astimezone().strftime('%Y-%m-%d')
        return None
    txt = str(raw).strip().strip('"')
    m = _re.match(r'^(\d{4})-(\d{2})-(\d{2})', txt)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = _re.match(r'^(\d{1,2})[.](\d{1,2})[.](\d{4})', txt)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    m = _re.match(r'^(\d{1,2})\s+([а-яА-Я]+)\s+(\d{4})', txt)
    if m and m.group(2).lower() in _MONTHS_RU:
        return f"{m.group(3)}-{_MONTHS_RU[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    import datetime as _dt
    for fmt in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(txt, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return None

class HealthWeightIn(BaseModel):
    date: Any   # всеядно: ISO, «25.10.2026, 10:15», «25 октября 2026 г. …», epoch (мини-мост v2)
    kg: float
    measuredAt: datetime | None = None


HealthCodeHeader = Annotated[str | None, Header(alias='X-DeepDish-Health-Code')]


def measurement_order(item: HealthWeightIn) -> int | None:
    stamp = item.measuredAt
    if stamp is None and isinstance(item.date, str):
        try:
            stamp = datetime.fromisoformat(item.date.strip())
        except ValueError:
            return None
    if stamp is None or stamp.utcoffset() is None:
        return None
    return int(stamp.timestamp() * 1000)


@app.post('/health/weight')
def health_weight(items: HealthWeightIn | list[HealthWeightIn], code: str = '',
                  health_code_header: HealthCodeHeader = None) -> dict[str, Any]:
    """Принимает один образец Shortcuts или пачку. За день хранится одно взвешивание."""
    u = auth_code(health_code_header if health_code_header is not None else code)
    uid = u['userId']
    samples = [items] if isinstance(items, HealthWeightIn) else items
    skipped = []
    by_day: dict[str, tuple[float, int | None]] = {}
    for item in samples:
        day = parse_date_flex(item.date)
        try:
            if day is None:
                raise ValueError('missing date')
            calendar_date.fromisoformat(day)
        except ValueError:
            skipped.append('invalid_date')
            continue
        if not 25 <= item.kg <= 350:
            skipped.append('invalid_weight')
            continue
        measured = measurement_order(item)
        previous = by_day.get(day)
        if previous is None or previous[1] is None or (measured is not None and measured >= previous[1]):
            by_day[day] = (round(item.kg, 2), measured)

    applied = 0
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        now = now_ms()
        stamp = advance_sync_stamp(c, sync_stamp(c), now)
        for day, (kg, measured) in by_day.items():
            iid = f'hw-{uid}-{day}'
            old = c.execute("SELECT body, updated, deleted FROM items WHERE kind='weightLogs' AND id=? AND owner=?",
                            (iid, uid)).fetchone()
            stored = json.loads(old['body']) if old else {}
            old_measurement = stored.get('bridgeMeasuredAt')
            if old_measurement is not None and (measured is None or measured < old_measurement):
                continue
            if (old and not old['deleted'] and stored.get('weightKg') == kg
                    and old_measurement == measured and stored.get('source') == 'health'):
                continue
            updated = max(now, old['updated'] + 1) if old else now
            body = {'id': iid, 'userId': uid, 'date': day, 'weightKg': kg, 'bodyFatPct': None,
                    'source': 'health', 'bridgeMeasuredAt': measured, 'createdAt': stored.get('createdAt', now),
                    'updatedAt': updated, 'deletedAt': None}
            c.execute("INSERT INTO items (kind, id, owner, updated, deleted, body, applied) "
                      "VALUES ('weightLogs', ?, ?, ?, 0, ?, ?) "
                      "ON CONFLICT(kind, id, owner) DO UPDATE SET updated = excluded.updated, deleted = 0, body = excluded.body, applied = excluded.applied",
                      (iid, uid, updated, json.dumps(body, ensure_ascii=False), stamp))
            applied += 1

        if by_day:
            # Старый мост записывал в deleted время замены без продвижения applied.
            # Переиздаём такие отметки один раз для дат, полученных от Health.
            rows = c.execute("SELECT id, body, updated FROM items WHERE kind='weightLogs' AND owner=? AND deleted != 1",
                             (uid,)).fetchall()
            for row in rows:
                body = json.loads(row['body'])
                day = body.get('date')
                if day not in by_day or row['id'] == f'hw-{uid}-{day}':
                    continue
                updated = max(now, row['updated'] + 1)
                body.update(deletedAt=updated, updatedAt=updated)
                c.execute("UPDATE items SET deleted=1, updated=?, body=?, applied=? WHERE kind='weightLogs' AND id=? AND owner=?",
                          (updated, json.dumps(body, ensure_ascii=False), stamp, row['id'], uid))
    log.info('health_weight applied=%d skipped=%d', applied, len(skipped))
    return {'ok': True, 'applied': applied, 'skipped': skipped}


@app.get('/health/day')
def health_day(date: str = '', code: str = '', health_code_header: HealthCodeHeader = None) -> JSONResponse:
    """итог калорий пользователя за дату — шорткат пишет его в Health (Dietary Energy)"""
    u = auth_code(health_code_header if health_code_header is not None else code)
    day = parse_date_flex(date) if date else calendar_date.today().isoformat()
    try:
        if day is None:
            raise ValueError('missing date')
        calendar_date.fromisoformat(day)
    except ValueError:
        raise HTTPException(422, 'нужна календарная дата в формате YYYY-MM-DD') from None
    kcal = 0.0
    with db() as c:
        rows = c.execute("SELECT body FROM items WHERE kind = 'entries' AND owner = ? AND deleted = 0",
                         (u['userId'],)).fetchall()
        for r in rows:
            b = json.loads(r['body'])
            if b.get('date') == day and not b.get('deletedAt'):
                kcal += (b.get('snapshot') or {}).get('kcal', 0)
    return JSONResponse({'date': day, 'kcal': round(kcal)}, headers={'Cache-Control': 'no-store'})



# ── мини-мост v2: страница-помощник сборки шортката ──────────────────────────
@app.get('/health/setup', response_class=HTMLResponse)
def health_setup() -> str:
    """Справка по запросам для команды и адреса без кода участника."""
    return """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deep Dish — мост Health</title>
<style>
 body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#14171B;color:#E9EDF2}
 h1{font-size:20px} h2{font-size:16px;margin-top:24px}
 .card{background:#1C232D;border-radius:14px;padding:14px;margin:10px 0}
 button{width:100%;padding:10px;border:none;border-radius:10px;background:#44748F;color:#fff;font-size:15px;margin-top:6px}
 code{display:block;background:#10151C;border-radius:8px;padding:8px;margin-top:6px;font-size:12px;word-break:break-all;color:#9ABCD9}
 ol{padding-left:20px;font-size:14px;line-height:1.55} li{margin:6px 0}
 .mut{color:#A9AFBA;font-size:13px}
</style></head><body>
<h1>Мост Apple Health</h1>
<p class="mut">Код для заголовка X-DeepDish-Health-Code: Deep Dish → Семья → «Мост Apple Health» → «Скопировать код».</p>
<div class="card"><h2>Импорт веса в Deep Dish</h2>
<ol>
<li><b>Найти данные «Здоровья»</b>: Тип — <i>Масса тела</i>; Порядок — <i>Сначала новые</i>; Лимит — <i>7</i>.</li>
<li><b>Повторить для каждого</b> (Repeat for Each) — подставь «Результаты Здоровья».</li>
<li>Внутри повтора — <b>Получить содержимое URL</b>: URL веса ниже. Метод <i>POST</i>, тело <i>JSON</i>. Поле <code>date</code> — локальная дата образца в формате <code>yyyy-MM-dd</code>, поле <code>kg</code> — масса в килограммах. Для выбора самого свежего взвешивания добавь <code>measuredAt</code> — дату и время ISO 8601 с часовым поясом.</li>
<li>Укажи заголовок <code>X-DeepDish-Health-Code</code> с кодом участника. Проверь ответ вручную и нажми «Синхронизировать» в Deep Dish.</li>
</ol></div>
<div class="card"><h2>Адрес импорта веса</h2><code id="u1"></code><button onclick="cp('u1')">Копировать URL веса</button></div>
<div class="card"><h2>Проверка суммы калорий</h2>
<p class="mut">Запрос GET с тем же заголовком и явной датой возвращает сумму уже синхронизированного дневника. Автоматическую запись в «Здоровье» подключай после проверки повторного запуска и поздних правок.</p>
<code id="u2"></code><button onclick="cp('u2')">Копировать URL суммы</button></div>
<script>
document.getElementById('u1').textContent = location.origin + '/health/weight';
document.getElementById('u2').textContent = location.origin + '/health/day?date=YYYY-MM-DD';
function cp(id){ const t=document.getElementById(id).textContent; if(navigator.clipboard) navigator.clipboard.writeText(t); else {const r=document.createRange();r.selectNode(document.getElementById(id));getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy');} }
</script></body></html>"""

def wire_change(row: sqlite3.Row) -> dict[str, Any]:
    body = json.loads(row['body'])
    if row['kind'] in PRIVATE_KINDS:
        body['userId'] = row['owner']
    if deleted_flag(row) and not body.get('deletedAt'):
        body['deletedAt'] = row['updated']
    return {'kind': row['kind'], 'body': body, 'updated': row['updated']}


def apply_sync_change(c: sqlite3.Connection, change: Change, user: sqlite3.Row,
                      stamp: int) -> tuple[str, dict[str, Any] | None]:
    kind, body = change.kind, dict(change.body)
    uid = user['userId']
    if kind not in ALL_KINDS:
        return 'rejected', None
    identity = {'profiles': uid, 'dayNormas': body.get('date')}.get(kind, body.get('id'))
    if not isinstance(identity, str) or not identity:
        return 'rejected', None
    try:
        updated = int(body.get('updatedAt') or 0)
        if not 0 < updated <= 2**53 - 1:
            return 'rejected', None
        json.dumps(body, allow_nan=False)
    except (ValueError, TypeError, OverflowError):
        return 'rejected', None

    if kind in PRIVATE_KINDS:
        current = c.execute('SELECT * FROM items WHERE kind=? AND id=? AND owner=?',
                            (kind, identity, uid)).fetchone()
        owner = uid
        body['userId'] = uid
    else:
        current = c.execute('SELECT * FROM items WHERE kind=? AND id=?', (kind, identity)).fetchone()
        owner = uid
        if current and current['owner'] not in (uid, 'local'):
            if current['owner'] == 'system' and body.get('source') == 'system':
                return 'current', None   # The system catalog is seeded on each device.
            if json.loads(current['body']) == body:
                return 'current', None   # An older client may echo a shared row.
            return 'rejected', None
        if not current and kind == 'foods' and body.get('source') == 'system' and body.get('ownerId') == 'system':
            owner = 'system'
        if kind in FAMILY_KINDS:
            body['userId'] = uid
    stored = json.loads(current['body']) if current else None
    body['ownerId'] = owner
    deleted = bool(body.get('deletedAt'))
    repair_legacy = False
    if kind == 'recipes' and current and current['deleted'] and not deleted:
        return 'current', wire_change(current)
    if kind == 'foods':
        explicit_delete = bool(current and current['deleted'] and stored.get('delBy') == 'user')
        if explicit_delete and (not deleted or body.get('delBy') != 'user'):
            return 'current', wire_change(current)
        if deleted and body.get('delBy') != 'user':
            # Early clients sent erroneous deletions after catalog deduplication.
            body = stored if stored else body
            body.update(deletedAt=None, delBy=None)
            deleted = False
            repair_legacy = True
        elif current and current['deleted'] and not deleted:
            repair_legacy = True

    if repair_legacy:
        updated = max(stamp, updated, current['updated'] + 1 if current else 0)
    body['ownerId'] = owner
    body['updatedAt'] = updated
    original_version = updated
    if current and current['updated'] >= updated and not repair_legacy:
        if stored == body:
            return 'current', None
        if change.baseUpdated != current['updated']:
            return 'current', wire_change(current)
        updated = max(stamp, current['updated'] + 1)
        body['updatedAt'] = updated
    c.execute("""INSERT INTO items (kind, id, owner, updated, deleted, body, applied)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT DO UPDATE SET owner = excluded.owner, updated = excluded.updated,
                   deleted = excluded.deleted, body = excluded.body, applied = excluded.applied""",
              (kind, identity, owner, updated, int(deleted), json.dumps(body, ensure_ascii=False), stamp))
    canonical = {'kind': kind, 'body': body, 'updated': updated}
    return 'applied', canonical if updated != original_version or repair_legacy else None


def store_sync_events(c: sqlite3.Connection, uid: str, events: list[dict[str, Any]]) -> None:
    for event in events[:500]:
        event_id, name = event.get('id'), event.get('name')
        if not isinstance(event_id, str) or not event_id or not isinstance(name, str):
            continue
        try:
            props = event.get('props') or {}
            if isinstance(props, str):
                props = json.loads(props)
            if not isinstance(props, dict):
                props = {}
            if name == 'off_search':
                props.pop('q', None)
            elif name == 'weight_logged':
                props.pop('kg', None)
            c.execute('INSERT OR IGNORE INTO events (id, userId, ts, name, props) VALUES (?,?,?,?,?)',
                      (event_id, uid, int(event.get('ts') or 0), name,
                       json.dumps(props, ensure_ascii=False, allow_nan=False)))
        except (ValueError, TypeError, OverflowError):
            continue


VISIBLE_SYNC_ITEMS = """SELECT kind, id, owner, body, updated, deleted, applied FROM items
  WHERE kind != 'offcache' AND
    (owner = ? OR (kind IN ('foods','recipes') AND
      (json_type(body, '$.isPublic') IS NULL OR json_extract(body, '$.isPublic') = 1))
      OR (kind = 'achievements' AND deleted = 0))"""
SYNC_ORDER = ' ORDER BY applied, kind, id, owner'


def pull_sync_page(c: sqlite3.Connection, uid: str, cursor: PullCursor, stamp: int,
                   legacy: bool) -> tuple[list[sqlite3.Row], PullCursor, bool]:
    if cursor.kind:
        after = ' AND (applied, kind, id, owner) > (?, ?, ?, ?)'
        start = (uid, cursor.applied, cursor.kind, cursor.id, cursor.owner)
    else:
        after = ' AND applied > ?'
        start = (uid, cursor.applied)
    rows = c.execute(VISIBLE_SYNC_ITEMS + after + SYNC_ORDER + ' LIMIT ?',
                     (*start, SYNC_PAGE_SIZE + 1)).fetchall()
    if len(rows) <= SYNC_PAGE_SIZE:
        return rows, PullCursor(applied=stamp), False

    last = rows[SYNC_PAGE_SIZE - 1]
    if legacy and rows[SYNC_PAGE_SIZE]['applied'] == last['applied']:
        # Older clients can only resume after a timestamp. Complete that group.
        rows = c.execute(VISIBLE_SYNC_ITEMS + after + ' AND applied <= ?' + SYNC_ORDER,
                         (*start, last['applied'])).fetchall()
        more = c.execute(VISIBLE_SYNC_ITEMS + ' AND applied > ? LIMIT 1',
                         (uid, last['applied'])).fetchone() is not None
        return rows, PullCursor(applied=last['applied']), more
    return rows[:SYNC_PAGE_SIZE], PullCursor(
        applied=last['applied'], kind=last['kind'], id=last['id'], owner=last['owner']), True


@app.post('/sync')
def sync(payload: SyncIn, user: sqlite3.Row = Depends(auth)) -> dict[str, Any]:
    uid = user['userId']
    results: list[str] = []
    corrections: list[dict[str, Any]] = []
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        wall_time = now_ms()
        previous = sync_stamp(c)
        stamp = advance_sync_stamp(c, previous, wall_time)
        for change in payload.changes:
            status, correction = apply_sync_change(c, change, user, stamp)
            results.append(status)
            if correction:
                corrections.append(correction)
        store_sync_events(c, uid, payload.events)
        requested = payload.cursor or PullCursor(applied=payload.since)
        if requested.applied > stamp or (payload.cursor and requested.applied > previous):
            requested = PullCursor()
        rows, cursor, more = (pull_sync_page(c, uid, requested, stamp, payload.cursor is None)
                              if payload.pull else ([], requested, False))

    out = [wire_change(row) for row in rows]
    applied, rejected = results.count('applied'), results.count('rejected')
    skew = payload.client_now - wall_time if payload.client_now else 0
    log.info('sync user=%s since=%d applied=%d rejected=%d out=%d events=%d skew_ms=%d',
             uid, requested.applied, applied, rejected, len(out), len(payload.events), skew)
    return {'changes': out, 'corrections': corrections, 'results': results,
            'serverTime': stamp, 'maxUpdated': cursor.applied, 'cursor': cursor.model_dump(),
            'hasMore': more, 'applied': applied, 'rejected': rejected}
