#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Воскрешение продуктов, удалённых tombstone-циклом (аудит 12.11).

Серверная выдача (sync, владелец) возвращает и УДАЛЁНЫЕ продукты владельцу —
тело помечается deletedAt. Эхо-дедупа (v0.7.10–0.7.14) не имеет провенанса
delBy='user' — это случайные жертвы, а не осознанные удаления. Скрипт тянет
все свои продукты, находит удалённые без delBy и возвращает их живыми push'ем
с updatedAt=сейчас (новее любого старого tombstone → LWW воскрешает и на
сервере 0.4.5, и на 0.4.6; applied обновится — все устройства получат).

  python tools/resurrect_foods.py [адрес] [токен] [--dry]

Без аргументов — прод (NAS), токен из tmp/_admin_tok.txt (вне репо!).
Идемпотентен: повтор не меняет живые записи; delBy='user' НЕ трогает.
"""
import json
import sys
import urllib.request

BASE = 'https://192.168.50.137:8687'
args = [a for a in sys.argv[1:] if not a.startswith('--')]
DRY = '--dry' in sys.argv
BASE = args[0] if args else BASE
TOK = args[1] if len(args) > 1 else open('tmp/_admin_tok.txt').read().strip()

import ssl
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE


def call(path, payload):
    req = urllib.request.Request(BASE + path, method='POST',
                                 data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer ' + TOK})
    return json.loads(urllib.request.urlopen(req, context=CTX, timeout=20).read())


# 1) полный pull своим токеном (владельцу возвращаются и удалённые)
r = call('/sync', {'since': 0, 'changes': [], 'events': [], 'client_now': 0})
foods = [ch['body'] for ch in r.get('changes', []) if ch.get('kind') == 'foods']
dead = [f for f in foods if f.get('deletedAt') and f.get('delBy') != 'user']
user_deleted = [f for f in foods if f.get('deletedAt') and f.get('delBy') == 'user']
print(f'продуктов получено: {len(foods)}; удалённых без провенанса (эхо дедупа): {len(dead)}; '
      f'осознанных удалений (delBy=user, не трогаем): {len(user_deleted)}')
for f in dead:
    print(f"  [могила] {f.get('name')} (updated {f.get('updatedAt')})")
for f in user_deleted:
    print(f"  [user]   {f.get('name')} — пропущен")

if not dead or DRY:
    print('нечего воскрешать' if not dead else 'DRY: выход без изменений')
    sys.exit(0)

# 2) воскрешение: живое тело с updatedAt=сейчас (сервер отвечает serverTime)
now = r['serverTime']
changes = []
for i, f in enumerate(dead):
    body = dict(f)
    body['deletedAt'] = None
    body['delBy'] = None
    body['updatedAt'] = now + i  # монотонность внутри батча
    changes.append({'kind': 'foods', 'body': body})
r2 = call('/sync', {'since': r['serverTime'], 'changes': changes, 'events': [], 'client_now': now})
print(f"push: sent={len(changes)} applied={r2.get('applied')} rejected={r2.get('rejected')}")

# 3) контрольная проверка
r3 = call('/sync', {'since': 0, 'changes': [], 'events': [], 'client_now': 0})
still = [ch['body']['name'] for ch in r3.get('changes', [])
         if ch.get('kind') == 'foods' and ch['body'].get('deletedAt') and ch['body'].get('delBy') != 'user']
print('контроль: удалённых без провенанса осталось', len(still), still[:5] if still else '— воскрешены ✓')
