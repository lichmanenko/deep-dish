# Deep Dish sync server: FastAPI + SQLite (WAL), один эндпоинт обмена POST /sync.
# Спецификация — SPEC.md §4–5: LWW по updatedAt, tombstone-удаления (очистка >90 дней),
# дневники приватные (фильтр по userId), каталог общий (isPublic), события метрик попутно.
import json
import logging
import logging.handlers
import os
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from typing import Any, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.environ.get('DD_DB', os.path.join(os.path.dirname(__file__), 'data', 'deepdish.db'))
TOMBSTONE_TTL_DAYS = 90

# v0.7.4: структурные логи в файл с ротацией (диагностика NAS вслепую стала невозможной)
os.makedirs(os.path.join(os.path.dirname(__file__), 'data'), exist_ok=True)
log = logging.getLogger('deepdish')
log.setLevel(logging.INFO)
_log_handler = logging.handlers.RotatingFileHandler(
    os.path.join(os.path.dirname(__file__), 'data', 'server.log'),
    maxBytes=1_000_000, backupCount=3, encoding='utf-8')
_log_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
log.addHandler(_log_handler)

# v0.7.4: авто-бэкап при синках — VACUUM INTO-снапшот без WAL-хвостов, ротация 30 копий
BACKUP_DIR = os.path.join(os.path.dirname(__file__), 'data', 'backups')
BACKUP_KEEP = 30
BACKUP_MIN_INTERVAL_S = 6 * 3600  # не чаще раза в 6 часов


def maybe_backup() -> None:
    marker = os.path.join(BACKUP_DIR, '.last')
    now = time.time()
    try:
        if os.path.exists(marker) and now - os.path.getmtime(marker) < BACKUP_MIN_INTERVAL_S:
            return
        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        dest = os.path.join(BACKUP_DIR, f'deepdish-{stamp}.db')
        conn = sqlite3.connect(DB_PATH)
        try:
            conn.execute('VACUUM INTO ?', (dest,))
        finally:
            conn.close()
        open(marker, 'w').close()
        os.utime(marker)
        old = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith('deepdish-') and f.endswith('.db'))
        for f in old[:-BACKUP_KEEP]:
            os.remove(os.path.join(BACKUP_DIR, f))
        log.info('backup saved: %s (total %d)', dest, min(len(old), BACKUP_KEEP))
    except Exception as e:  # бэкап не должен ронять синк
        log.warning('backup failed: %s', e)


# kinds: общий каталог vs личные данные
PUBLIC_KINDS = {'foods', 'recipes'}
PRIVATE_KINDS = {'entries', 'weightLogs', 'dayNormas', 'slots', 'savedMeals', 'profiles'}
ALL_KINDS = PUBLIC_KINDS | PRIVATE_KINDS

app = FastAPI(title='Deep Dish sync', version='0.4.0')
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
        # мост Apple Health (M3): короткий код вместо длинного токена в шорткате
        try:
            c.execute('ALTER TABLE users ADD COLUMN healthCode TEXT')
        except sqlite3.OperationalError:
            pass  # колонка уже есть


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
    log.info('register nick=%s role=%s', nickname, role)
    return {'userId': user_id, 'token': token, 'role': role}


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
                p_ = (e['props'] or '{}')
                if '"online":true' in p_ or '"online": True' in p_:
                    online_t += 1
                elif '"online":false' in p_:
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
        c.execute('INSERT INTO items (kind, id, owner, updated, deleted, body) VALUES (?,?,?,?,?,?) ON CONFLICT (kind, id) DO UPDATE SET updated = excluded.updated, body = excluded.body',
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
        raise HTTPException(401, 'нужен код моста: ?code=...')
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
        cur = c.execute('SELECT healthCode FROM users WHERE userId = ?', (user['userId'],)).fetchone()['healthCode']
        if reset or not cur:
            for _ in range(5):
                code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(10))
                if not c.execute('SELECT 1 FROM users WHERE healthCode = ?', (code,)).fetchone():
                    c.execute('UPDATE users SET healthCode = ? WHERE userId = ?', (code, user['userId']))
                    cur = code
                    break
    return {'code': cur}


class HealthWeightIn(BaseModel):
    date: str   # YYYY-MM-DD
    kg: float


@app.post('/health/weight')
def health_weight(items: list[HealthWeightIn], code: str = '') -> dict[str, Any]:
    """шорткат присылает взвешивания пачкой (например, за 7 дней); повтор — обновление, не дубль"""
    u = auth_code(code)
    import re as _re
    now = now_ms()
    applied = 0
    with db() as c:
        for it in items:
            if not _re.match(r'^\d{4}-\d{2}-\d{2}$', it.date) or not (25 <= it.kg <= 350):
                continue
            iid = "hw-" + u['userId'] + "-" + it.date
            body = json.dumps({'id': iid, 'userId': u['userId'], 'date': it.date,
                               'weightKg': round(it.kg, 2), 'bodyFatPct': None,
                               'createdAt': now, 'updatedAt': now, 'deletedAt': None},
                              ensure_ascii=False)
            # Е1(ревью-2): повторная посылка воскрешает запись (deleted = 0)
            c.execute("INSERT INTO items (kind, id, owner, updated, deleted, body) "
                      "VALUES ('weightLogs', ?, ?, ?, 0, ?) "
                      "ON CONFLICT(kind, id) DO UPDATE SET updated = excluded.updated, deleted = 0, body = excluded.body",
                      (iid, u['userId'], now, body))
            applied += 1
        # Е6(ревью-2): дедуп одним проходом — ручные записи пришедших дат уходят в tombstone
        dates = {it.date for it in items
                 if _re.match(r'^\d{4}-\d{2}-\d{2}$', it.date) and 25 <= it.kg <= 350}
        own = {'hw-' + u['userId'] + '-' + d for d in dates}
        for r in c.execute("SELECT id, body FROM items WHERE kind = 'weightLogs' AND owner = ? AND deleted = 0",
                           (u['userId'],)).fetchall():
            if r['id'] in own:
                continue  # сами мостовые записи этой пачки
            if json.loads(r['body']).get('date') in dates:
                c.execute('UPDATE items SET deleted = ? WHERE kind = ? AND id = ?', (now, 'weightLogs', r['id']))
    log.info('health_weight user=%s nick=%s applied=%d', u['userId'], u['nickname'], applied)
    return {'ok': True, 'applied': applied}


@app.get('/health/day')
def health_day(date: str, code: str = '') -> dict[str, Any]:
    """итог калорий пользователя за дату — шорткат пишет его в Health (Dietary Energy)"""
    u = auth_code(code)
    kcal = 0.0
    with db() as c:
        rows = c.execute("SELECT body FROM items WHERE kind = 'entries' AND owner = ? AND deleted = 0",
                         (u['userId'],)).fetchall()
        for r in rows:
            b = json.loads(r['body'])
            if b.get('date') == date and not b.get('deletedAt'):
                kcal += (b.get('snapshot') or {}).get('kcal', 0)
    return {'date': date, 'kcal': round(kcal)}


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
                # Д4(ревью): перезаписывать чужой продукт нельзя — только свой (форк = новый id)
                cur_owner = c.execute('SELECT owner FROM items WHERE kind = ? AND id = ?', (ch.kind, cid)).fetchone()
                if cur_owner and cur_owner['owner'] not in (uid, 'system'):
                    rejected += 1
                    continue
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
        rows = c.execute('''SELECT kind, body, updated, deleted FROM items
                            WHERE updated > ? AND kind != 'offcache' AND (owner = ? OR (kind IN ('foods','recipes') AND deleted = 0))
                            ORDER BY updated LIMIT 5000''',
                         (payload.since, uid)).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            body = json.loads(r['body'])
            if r['kind'] in PUBLIC_KINDS and not body.get('isPublic', True) and body.get('ownerId') != uid:
                continue  # чужие черновики каталога не рассылаем
            # Е1(ревью-2): серверная пометка deleted (мост-дедуп и т.п.) должна доезжать в теле
            if deleted_flag(r) and not body.get('deletedAt'):
                body['deletedAt'] = r['updated']
            out.append({'kind': r['kind'], 'body': body, 'updated': r['updated']})

        # 4) чистка старых tombstone (не чаще раза в час — по факту запроса, дёшево на SQLite)
        c.execute('DELETE FROM items WHERE deleted = 1 AND updated < ?', (server_now - TOMBSTONE_TTL_DAYS * 86400000,))

    # Д2(ревью): курсор клиента — последняя фактически отданная запись (не текущее время сервера),
    # иначе хвост за LIMIT 5000 теряется навсегда
    max_updated = out[-1]['updated'] if out else None
    if applied or payload.events:
        log.info('sync user=%s nick=%s applied=%d rejected=%d out=%d events=%d',
                 uid, user['nickname'], applied, rejected, len(out), len(payload.events))
    maybe_backup()
    return {'changes': out, 'serverTime': server_now, 'maxUpdated': max_updated, 'applied': applied, 'rejected': rejected}
