#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Синк-телеметрия прода (v0.4.4): забор /admin/telemetry с NAS и человекочитаемая сводка.

Задача агента-ритуала (В., 26.10: «всегда понимать причины недолетов»):
  python tools/telemetry.py [адрес] [админ-токен]
Без аргументов — адрес по умолчанию (NAS), токен из tmp/_admin_tok.txt (вне репо!).
Сводка: последние исходы синка по юзерам (курсоры, rejected, skew), ошибки клиентов.
Признаки проблем подсвечиваются [!]: rejected>0, |skew|>5 мин, localPending>0 при applied=0.
"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'https://192.168.50.137:8687'
TOK = sys.argv[2] if len(sys.argv) > 2 else open('tmp/_admin_tok.txt').read().strip()

req = urllib.request.Request(BASE + '/admin/telemetry?limit=300',
                             headers={'Authorization': 'Bearer ' + TOK})
try:
    import ssl
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    data = json.loads(urllib.request.urlopen(req, context=ctx, timeout=10).read())
except Exception as e:
    print('не удалось забрать телеметрию:', e)
    sys.exit(1)

print('=== Последние синки по пользователям ===')
for uid, last in sorted(data['latestByUser'].items(), key=lambda kv: -kv[1]['ts']):
    import datetime
    t = datetime.datetime.fromtimestamp(last['ts'] / 1000).strftime('%d.%m %H:%M')
    flags = []
    if last.get('rejectedByServer', 0) > 0:
        flags.append(f"[!] rejected={last['rejectedByServer']}")
    skew = last.get('skewMs', 0)
    if abs(skew) > 5 * 60 * 1000:
        flags.append(f"[!] skew={skew // 1000}с")
    if last.get('localPendingBeforeSync', 0) > 0 and last.get('appliedByServer', 0) == 0 and last.get('sent', 0) == 0:
        flags.append(f"[!] {last['localPendingBeforeSync']} локальных изменений не уехали")
    print(f"  {last.get('nick')}: {t} | applied={last.get('appliedByServer')} pulled={last.get('pulled')} "
          f"sent={last.get('sent')} since→{last.get('sinceBefore')}→{last.get('sinceAfter')} {' '.join(flags)}")

print()
print('=== Последние события (sync/client, 15) ===')
for e in data['events'][:15]:
    import datetime
    t = datetime.datetime.fromtimestamp(e['ts'] / 1000).strftime('%d.%m %H:%M:%S')
    mark = '[!]' if e['name'] in ('sync_fail', 'client_error', 'clock_skew') else '   '
    print(f"  {t} {mark} {e.get('nick')}: {e['name']} {json.dumps(e['props'], ensure_ascii=False)[:110]}")
