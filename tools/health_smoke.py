# -*- coding: utf-8 -*-
"""HTTP-проверка моста Apple Health на отдельной синтетической базе.

Требует локальный сервер с пустой SQLite (DD_DB должен указывать на файл теста).
Использование: python tools/health_smoke.py http://127.0.0.1:8689

Проверяет: код моста (создание/сброс), пачку весов, идемпотентность по дате,
воскрешение после удаления (Е1), проброс серверного tombstone в тело выдачи /sync (Е1),
итог калорий дня, отказ чужим кодом.
"""
import json
import secrets
import sys
import time
from urllib.parse import urlsplit
import urllib.request

BASE_MS = int(time.time() * 1000)

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8689'
if urlsplit(BASE).hostname not in {'127.0.0.1', 'localhost', '::1'}:
    sys.exit('Нужен локальный сервер с отдельной синтетической базой')
FAILS = []


def call(method, path, body=None, headers=None, expect=200):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == expect, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code == expect, json.loads(e.read().decode() or '{}')


def check(name, ok):
    print(('OK  ' if ok else 'FAIL') + ' ' + name)
    if not ok:
        FAILS.append(name)


# 1) тестовый пользователь + bearer
nick = 'smoke-' + secrets.token_hex(3)
ok, r = call('POST', '/register', {'nickname': nick})
check('register', ok and r.get('token'))
if not ok:
    sys.exit('Запустите проверку на пустой синтетической базе')
tok = r['token']
auth = {'Authorization': 'Bearer ' + tok}

# 2) код моста
ok, r = call('POST', '/health/code', {}, auth)
check('код моста выдан', ok and len(r.get('code', '')) == 10)
code = r['code']
ok, r = call('POST', '/health/code', {'reset': True}, auth)
check('сброс кода меняет его', ok and r.get('code') and r['code'] != code)
code = r['code']
bridge = {'X-DeepDish-Health-Code': code}

# 3) чужой код не проходит
ok, _ = call('POST', '/health/weight?code=WRONGCODE1', [{'date': '2026-01-01', 'kg': 80}], expect=401)
check('чужой код отклонён', ok)

# 4) пачка весов + идемпотентность
ok, r = call('POST', '/health/weight?code=' + code, [
    {'date': '2026-01-01', 'kg': 80.0},
    {'date': '2026-01-02', 'kg': 79.8},
    {'date': '01-01-2026', 'kg': 79.0},   # мусорная дата — должна быть отброшена
    {'date': '2026-01-03', 'kg': 500},    # вне диапазона — отброшена
])
check('пачка: применено 2 из 4', ok and r.get('applied') == 2)
ok, r = call('POST', '/health/weight?code=' + code, [{'date': '2026-01-02', 'kg': 79.9}])
check('повтор той же даты — applied=1 (обновление)', ok and r.get('applied') == 1)

# 5) выдача /sync: вес за 2026-01-02 == 79.9
ok, r = call('POST', '/sync', {'since': 0, 'changes': [], 'events': []}, auth)
wl = [c for c in r.get('changes', []) if c['kind'] == 'weightLogs']
by_date = {json.loads(json.dumps(c)) and c['body'].get('date'): c['body'] for c in wl}
check('вес 02.01 в выдаче = 79,9', by_date.get('2026-01-02', {}).get('weightKg') == 79.9)

# 6) Е1: клиентское удаление (tombstone через /sync) + повторная посылка мостом = воскрешение
iid = 'hw-' + [c for c in r.get('changes', []) if c['kind'] == 'weightLogs'][0]['body']['userId'] + '-2026-01-02'
ok, r = call('POST', '/sync', {'since': r['maxUpdated'] or 0, 'changes': [
    {'kind': 'weightLogs', 'body': {'id': iid, 'userId': 'x', 'date': '2026-01-02', 'weightKg': 79.9,
                                    'createdAt': 1, 'updatedAt': BASE_MS + 2, 'deletedAt': BASE_MS + 2}}],
    'events': []}, auth)
check('tombstone принят', ok)
ok, r = call('POST', '/health/weight?code=' + code, [{'date': '2026-01-02', 'kg': 79.7}])
ok, r = call('POST', '/sync', {'since': 0, 'changes': [], 'events': []}, auth)
body2 = [c['body'] for c in r['changes'] if c['kind'] == 'weightLogs' and c['body'].get('date') == '2026-01-02'][0]
check('Е1: после повтора моста запись жива (deletedAt нет)', body2.get('deletedAt') is None)
check('Е1: вес обновлён до 79,7', body2.get('weightKg') == 79.7)

# 7) Е1: серверный tombstone (дедуп ручного веса) доезжает в теле
call('POST', '/sync', {'since': r.get('maxUpdated') or 0, 'changes': [
    {'kind': 'weightLogs', 'body': {'id': f'manual-{BASE_MS}', 'userId': 'x', 'date': '2026-01-01', 'weightKg': 80,
                                    'createdAt': 1, 'updatedAt': BASE_MS + 1}}], 'events': []}, auth)
call('POST', '/health/weight?code=' + code, [{'date': '2026-01-01', 'kg': 80.1}])
ok, r = call('POST', '/sync', {'since': 0, 'changes': [], 'events': []}, auth)
manual = [c['body'] for c in r['changes'] if c['kind'] == 'weightLogs' and c['body'].get('id') == f'manual-{BASE_MS}'][0]
check('Е1: серверный tombstone виден клиенту (deletedAt в теле)', bool(manual.get('deletedAt')))

# Запрос словарём соответствует действию JSON в «Быстрых командах». Старая пачка остаётся совместимой.
latest = {'date': '2026-01-04', 'kg': 79.5, 'measuredAt': '2026-01-04T00:30:00+03:00'}
earlier = {'date': '2026-01-04', 'kg': 79.8, 'measuredAt': '2026-01-04T00:05:00+03:00'}
ok, first = call('POST', '/health/weight', latest, bridge)
check('один JSON-объект с заголовком', ok and first.get('applied') == 1)
ok, repeat = call('POST', '/health/weight', latest, bridge)
check('повтор того же измерения ничего не меняет', ok and repeat.get('applied') == 0)
ok, old = call('POST', '/health/weight', [earlier], bridge)
check('старое показание не заменяет новое', ok and old.get('applied') == 0)
ok, day_sync = call('POST', '/sync', {'since': 0, 'changes': []}, auth)
record = next((c['body'] for c in day_sync.get('changes', []) if c['kind'] == 'weightLogs'
               and c['body'].get('date') == '2026-01-04'), {})
check('замер у полуночи остался на локальной дате', ok and record.get('weightKg') == 79.5)

old_id = f'manual-incremental-{BASE_MS}'
_, before = call('POST', '/sync', {'since': 0, 'changes': [
    {'kind': 'weightLogs', 'body': {'id': old_id, 'date': '2026-01-05', 'weightKg': 77,
                                    'createdAt': BASE_MS, 'updatedAt': BASE_MS}}]}, auth)
time.sleep(.02)
call('POST', '/health/weight', {'date': '2026-01-05', 'kg': 76.5}, bridge)
ok, delta = call('POST', '/sync', {'since': before['maxUpdated'], 'changes': []}, auth)
weight_delta = [c['body'] for c in delta.get('changes', []) if c['kind'] == 'weightLogs']
check('инкрементально дошла замена ручного веса', ok
      and any(item['id'] == old_id and item.get('deletedAt') for item in weight_delta)
      and any(item.get('weightKg') == 76.5 and item.get('source') == 'health' for item in weight_delta))
ok, invalid = call('POST', '/health/weight', {'date': '2026-02-30', 'kg': 76}, bridge)
check('невозможная дата веса пропускается', ok and invalid.get('skipped') == ['invalid_date'])

# 8) итог дня и поздняя правка на NAS
entry = {'id': f'e-{BASE_MS}', 'date': '2026-01-02', 'slotId': 's', 'kind': 'food',
         'refId': 'f', 'grams': 100, 'snapshot': {'kcal': 250, 'p': 1, 'f': 1, 'c': 1},
         'timeEaten': '12:00', 'createdAt': 1, 'updatedAt': BASE_MS + 3}
call('POST', '/sync', {'since': 0, 'changes': [{'kind': 'entries', 'body': entry}]}, auth)
ok, r = call('GET', '/health/day?date=2026-01-02', headers=bridge)
check('итог локальной даты = 250', ok and r.get('date') == '2026-01-02' and r.get('kcal') == 250)
entry['snapshot']['kcal'] = 275
entry['updatedAt'] += 1
call('POST', '/sync', {'since': 0, 'changes': [{'kind': 'entries', 'body': entry}]}, auth)
ok, r = call('GET', '/health/day?date=2026-01-02', headers=bridge)
check('после поздней правки API отдаёт 275, а не сумму двух версий', ok and r.get('kcal') == 275)
ok, _ = call('GET', '/health/day?date=2026-02-30', headers=bridge, expect=422)
check('явная невозможная дата калорий отклоняется', ok)

print('\n' + ('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' if not FAILS else f'ПРОВАЛЕНО: {len(FAILS)}: {FAILS}'))
sys.exit(1 if FAILS else 0)
