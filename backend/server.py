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
FAMILY_KINDS = {'achievements'}  # v0.7.6: публичные записи семьи (достижения — факт известен всем)
ALL_KINDS = PUBLIC_KINDS | PRIVATE_KINDS | FAMILY_KINDS

app = FastAPI(title='Deep Dish sync', version='0.4.4')
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


def _meta_ready(c: sqlite3.Connection) -> bool:
    try:
        c.execute("SELECT 1 FROM _meta LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


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
        # v0.4.2 (срочный фикс «кексов», В., 26.10): серверное время применения — единственная
        # мера новизны в выдаче; клиентские updatedAt пригодны только для LWW (телефонные часы врут)
        cols = [r['name'] for r in c.execute("PRAGMA table_info(items)")]
        if 'applied' not in cols:
            c.execute("ALTER TABLE items ADD COLUMN applied INTEGER NOT NULL DEFAULT 0")
            c.execute("UPDATE items SET applied = updated")
        # v0.4.3 (инцидент «кексы», финал): applied старых записей мог «запечататься» клиентскими
        # часами из updated — получатели с более поздним курсором никогда не увидят их. Один раз
        # при старте: всем существующим записям свежий applied → ближайший синк каждого клиента
        # получит полную базу (идемпотентные put по id), дальше курсор живёт по серверным часам.
        mark = c.execute("SELECT v FROM _meta WHERE k = 'applied_refresh'").fetchone() if _meta_ready(c) else None
        if not mark:
            c.execute("UPDATE items SET applied = ? WHERE kind != 'offcache'", (int(time.time() * 1000),))
            c.execute("CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT)")
            c.execute("INSERT OR REPLACE INTO _meta (k, v) VALUES ('applied_refresh', '1')")
        c.execute('CREATE INDEX IF NOT EXISTS idx_items_applied ON items (applied)')
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
    client_now: int = 0  # часы устройства (телеметрия skew, v0.4.4)


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
        latest: dict[str, Any] = {}
        for r in c.execute("SELECT ts, userId, props FROM events WHERE name = 'sync_result' ORDER BY ts DESC").fetchall():
            if r['userId'] in latest:
                continue
            latest[r['userId']] = {'nick': nick.get(r['userId']), 'ts': r['ts'], **json.loads(r['props'] or '{}')}
        return {'events': [{'ts': r['ts'], 'nick': nick.get(r['userId']), 'name': r['name'],
                            'props': json.loads(r['props'] or '{}')} for r in evs],
                'latestByUser': latest}


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


@app.post('/health/weight')
def health_weight(items: list[HealthWeightIn], code: str = '') -> dict[str, Any]:
    """шорткат присылает взвешивания пачкой (например, за 7 дней); повтор — обновление, не дубль"""
    u = auth_code(code)
    import re as _re
    now = now_ms()
    server_now = now  # v0.4.2: applied-время мостовых записей (выдача по серверным часам)
    applied = 0
    with db() as c:
        skipped = []
        for it in items:
            d = parse_date_flex(it.date)
            if not d or not (25 <= it.kg <= 350):
                skipped.append(str(it.date)[:40])
                continue
            iid = "hw-" + u['userId'] + "-" + d
            body = json.dumps({'id': iid, 'userId': u['userId'], 'date': d,
                               'weightKg': round(it.kg, 2), 'bodyFatPct': None,
                               'createdAt': now, 'updatedAt': now, 'deletedAt': None},
                              ensure_ascii=False)
            # Е1(ревью-2): повторная посылка воскрешает запись (deleted = 0)
            c.execute("INSERT INTO items (kind, id, owner, updated, deleted, body, applied) "
                      "VALUES ('weightLogs', ?, ?, ?, 0, ?, ?) "
                      "ON CONFLICT(kind, id) DO UPDATE SET updated = excluded.updated, deleted = 0, body = excluded.body, applied = excluded.applied",
                      (iid, u['userId'], now, body, server_now))
            applied += 1
        # Е6(ревью-2): дедуп одним проходом — ручные записи пришедших дат уходят в tombstone
        dates = {d for it in items
                 if (d := parse_date_flex(it.date)) and 25 <= it.kg <= 350}
        own = {'hw-' + u['userId'] + '-' + d for d in dates}
        for r in c.execute("SELECT id, body FROM items WHERE kind = 'weightLogs' AND owner = ? AND deleted = 0",
                           (u['userId'],)).fetchall():
            if r['id'] in own:
                continue  # сами мостовые записи этой пачки
            if json.loads(r['body']).get('date') in dates:
                c.execute('UPDATE items SET deleted = ? WHERE kind = ? AND id = ?', (now, 'weightLogs', r['id']))
    log.info('health_weight user=%s nick=%s applied=%d skipped=%s', u['userId'], u['nickname'], applied, skipped)
    return {'ok': True, 'applied': applied, 'skipped': skipped}


@app.get('/health/day')
def health_day(date: str = '', code: str = '') -> dict[str, Any]:
    """итог калорий пользователя за дату — шорткат пишет его в Health (Dietary Energy)"""
    u = auth_code(code)
    import datetime as _dt
    date = parse_date_flex(date) or _dt.date.today().isoformat()
    kcal = 0.0
    with db() as c:
        rows = c.execute("SELECT body FROM items WHERE kind = 'entries' AND owner = ? AND deleted = 0",
                         (u['userId'],)).fetchall()
        for r in rows:
            b = json.loads(r['body'])
            if b.get('date') == date and not b.get('deletedAt'):
                kcal += (b.get('snapshot') or {}).get('kcal', 0)
    return {'date': date, 'kcal': round(kcal)}



# ── мини-мост v2: страница-помощник сборки шортката ──────────────────────────
from fastapi.responses import HTMLResponse


@app.get('/health/setup', response_class=HTMLResponse)
def health_setup() -> str:
    """Страница для сборки шортката: вставил код — получил готовые URL для копирования."""
    return """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deep Dish — мост Health</title>
<style>
 body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#14171B;color:#E9EDF2}
 h1{font-size:20px} h2{font-size:16px;margin-top:24px}
 .card{background:#1C232D;border-radius:14px;padding:14px;margin:10px 0}
 input{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border-radius:10px;border:1px solid #2A3542;background:#10151C;color:#E9EDF2}
 button{width:100%;padding:10px;border:none;border-radius:10px;background:#44748F;color:#fff;font-size:15px;margin-top:6px}
 code{display:block;background:#10151C;border-radius:8px;padding:8px;margin-top:6px;font-size:12px;word-break:break-all;color:#9ABCD9}
 ol{padding-left:20px;font-size:14px;line-height:1.55} li{margin:6px 0}
 .mut{color:#A9AFBA;font-size:13px}
</style></head><body>
<h1>Мост Apple Health — сборка за 6 шагов</h1>
<p class="mut">Код моста: Deep Dish → Семья → «Мост Apple Health» → «Скопировать код».</p>
<input id="code" placeholder="Вставь код моста (10 знаков)" inputmode="latin">
<div class="card"><h2>Шаги в «Быстрых командах»</h2>
<ol>
<li><b>Найти данные «Здоровья»</b>: Тип — <i>Масса тела</i>; Порядок — <i>Сначала новые</i>; Лимит — <i>7</i>.</li>
<li><b>Повторить для каждого</b> (Repeat for Each) — подставь «Результаты Здоровья».</li>
<li>Внутри повтора — <b>Получить содержимое URL</b>: адрес ниже (URL 1). Разверни: Метод — <i>POST</i> → Тип запроса — <i>JSON</i>; поле <code>date</code> = <i>Дата образца</i>, поле <code>kg</code> = <i>Значение</i>.</li>
<li>После повтора — <b>Получить содержимое URL</b>: адрес ниже (URL 2), метод GET.</li>
<li><b>Получить значение из словаря</b>: ключ <code>kcal</code>, из результата шага 4.</li>
<li><b>Записать данные «Здоровья»</b>: Тип — <i>Пищевая энергия</i>, Значение — из шага 5, Единица — <i>ккал</i>.</li>
</ol></div>
<div class="card"><h2>Готовые адреса (код подставится сам)</h2>
<h2>URL 1 — вес (POST)</h2><code id="u1">вставь код выше</code><button onclick="cp('u1')">Копировать URL 1</button>
<h2>URL 2 — калории дня (GET)</h2><code id="u2">вставь код выше</code><button onclick="cp('u2')">Копировать URL 2</button></div>
<div class="card"><h2>Автоматизация 23:30</h2>
<p class="mut">«Автоматизации» → «+» → «Время дня» → 23:30, ежедневно → выбрать эту команду → выключить «Спрашивать перед запуском».</p></div>
<script>
const base = location.origin;
const code = () => document.getElementById('code').value.trim();
function upd(){ document.getElementById('u1').textContent = code() ? base+'/health/weight?code='+code() : 'вставь код выше';
 document.getElementById('u2').textContent = code() ? base+'/health/day?code='+code() : 'вставь код выше'; }
function cp(id){ const t=document.getElementById(id).textContent; if(navigator.clipboard) navigator.clipboard.writeText(t); else {const r=document.createRange();r.selectNode(document.getElementById(id));getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy');} }
document.getElementById('code').addEventListener('input', upd);
</script></body></html>"""

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
                # v0.4.2: старый клиент шлёт ownerId='local' — это МЕТКА устройства, не владелец;
                # владельцем записи становится автор запроса (иначе Д4 отвергала автора его же продукт)
                if owner == 'local':
                    owner = uid
                    body['ownerId'] = uid
                body['ownerId'] = owner  # каталог: автор = ownerId (может быть system у форков)
                # Д4(ревью): перезаписывать чужой продукт нельзя — только свой (форк = новый id);
                # 'local' — наследие старого клиента, считаем ничейным: перезапись разрешена
                cur_owner = c.execute('SELECT owner FROM items WHERE kind = ? AND id = ?', (ch.kind, cid)).fetchone()
                if cur_owner and cur_owner['owner'] not in (uid, 'system', 'local'):
                    rejected += 1
                    continue
                if owner != uid and owner != 'system' and not body.get('isPublic', True):
                    rejected += 1
                    continue
            elif ch.kind in FAMILY_KINDS:
                body['ownerId'] = uid  # семейно-публичное: автор владеет записью, видят все
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
            c.execute('''INSERT INTO items (kind, id, owner, updated, deleted, body, applied)
                         VALUES (?,?,?,?,?,?,?)
                         ON CONFLICT (kind, id) DO UPDATE SET
                           owner = excluded.owner, updated = excluded.updated,
                           deleted = excluded.deleted, body = excluded.body, applied = excluded.applied''',
                      (ch.kind, cid, uid if ch.kind not in PUBLIC_KINDS else owner, updated, deleted,
                       json.dumps(body, ensure_ascii=False), server_now))
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
        rows = c.execute('''SELECT kind, body, updated, deleted, applied FROM items
                            WHERE applied > ? AND kind != 'offcache'
                              AND (owner = ? OR (kind IN ('foods','recipes','achievements') AND deleted = 0))
                            ORDER BY applied LIMIT 5000''',
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
        pass

    # Д2(ревью): курсор — последняя фактически отданная запись; выдача короче лимита — значит
    # исчерпана до «сейчас». Мусорные applied в базе на курсор не влияют (счёт по отданным строкам).
    max_updated = rows[-1]['applied'] if len(rows) >= 5000 else server_now
    skew_ms = (payload.client_now - server_now) if payload.client_now else 0
    log.info('sync user=%s nick=%s since=%d applied=%d rejected=%d out=%d events=%d skew_ms=%d',
             uid, user['nickname'], payload.since, applied, rejected, len(out), len(payload.events), skew_ms)
    maybe_backup()
    return {'changes': out, 'serverTime': server_now, 'maxUpdated': max_updated, 'applied': applied, 'rejected': rejected}
