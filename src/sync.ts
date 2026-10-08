// Клиент семейного синка (M2): обмен POST /sync по SPEC §4.
// Один bearer-токен на устройство, since = serverTime прошлого ответа,
// отправка изменений (updatedAt > lastPush) + досыл событий метрик.
import { db } from './db';

export interface SyncSettings {
  server: string;      // https://nas:8687 или http://192.168.x.x:8687 (в сети дома)
  userId: string;
  token: string;
  nickname: string;
  role: 'admin' | 'member';
  since: number;       // serverTime последнего успешного обмена
  lastPush: number;    // client updatedAt, всё что новее — кандидаты на отправку
  lastOk: number;      // ts последнего успешного синка (для статуса)
}

const KEY = 'dd-sync';
const TABLES = {
  foods: db.foods, recipes: db.recipes, entries: db.entries,
  weightLogs: db.weightLogs, dayNormas: db.dayNormas,
  slots: db.slots, savedMeals: db.savedMeals,
} as const;
type Kind = keyof typeof TABLES;
const PROFILE_KEY = 'profiles' as const;
const PRIVATE_KINDS = new Set(['entries', 'weightLogs', 'dayNormas', 'slots', 'savedMeals']);

export function loadSync(): SyncSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}
export function saveSync(s: SyncSettings | null) {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}

/** регистрация устройства на сервере; первый участник становится admin */
export async function registerDevice(server: string, nickname: string, adminToken?: string): Promise<SyncSettings> {
  const url = server.replace(/\/+$/, '') + '/register';
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, adminToken }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error((await res.text()) || `сервер ответил ${res.status}`);
  const r = await res.json();
  return { server, userId: r.userId, token: r.token, nickname, role: r.role, since: 0, lastPush: 0, lastOk: 0 };
}

export interface SyncResult { ok: boolean; pushed: number; pulled: number; error?: string }

/** один обмен: свои изменения + события → сервер; чужие/общие изменения → себе */
export async function runSync(): Promise<SyncResult> {
  const st = loadSync();
  if (!st) return { ok: false, pushed: 0, pulled: 0, error: 'синк не настроен' };
  const base = st.server.replace(/\/+$/, '');

  // собрать свои изменения новее lastPush
  const changes: Array<{ kind: string; body: unknown }> = [];
  for (const k of Object.keys(TABLES) as Kind[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (TABLES[k] as any)
      .filter((x: { updatedAt: number }) => x.updatedAt > st.lastPush)
      .limit(2000).toArray() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const body = { ...r };
      if (PRIVATE_KINDS.has(k)) body.userId = st.userId;
      changes.push({ kind: k, body });
    }
  }
  const pr = await db.profiles.get('local');
  if (pr) changes.push({ kind: PROFILE_KEY, body: { ...pr } });

  const evs = (await db.events.orderBy('ts').reverse().limit(500).toArray()).map(e => ({
    id: e.id, ts: e.ts, name: e.name, props: e.props,
  })).reverse();

  const res = await fetch(base + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token },
    body: JSON.stringify({ since: st.since, changes, events: evs }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const r = await res.json();

  // применить входящие
  let pulled = 0;
  for (const ch of (r.changes ?? []) as Array<{ kind: string; body: Record<string, unknown> }>) {
    const body = { ...ch.body };
    if (ch.kind === PROFILE_KEY) {
      if (body.userId !== 'local') {
        // профиль с сервера: единственный локальный пользователь — свой
        body.userId = 'local';
        if ((pr?.updatedAt ?? 0) < (body.updatedAt as number)) await db.profiles.put(body as never);
      }
      continue;
    }
    if (!(ch.kind in TABLES)) continue;
    if (PRIVATE_KINDS.has(ch.kind)) body.userId = 'local'; // личное всегда локальный пользователь
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (TABLES[ch.kind as Kind] as any).put(body);
    pulled++;
  }

  const nowLocal = Date.now();
  saveSync({ ...st, since: r.serverTime, lastPush: Math.max(st.lastPush, nowLocal - 1), lastOk: nowLocal });
  return { ok: true, pushed: r.applied ?? changes.length, pulled };
}

/** авто-синк: при старте и возврате сети, не чаще раза в 5 минут */
let lastAuto = 0;
export function autoSync() {
  const st = loadSync();
  if (!st || !navigator.onLine) return;
  const now = Date.now();
  if (now - lastAuto < 5 * 60 * 1000) return;
  lastAuto = now;
  runSync().catch(() => { /* тихо: повторится при следующем триггере */ });
}

export function syncStatusText(): string {
  const st = loadSync();
  if (!st) return 'не настроен';
  const mins = st.lastOk ? Math.round((Date.now() - st.lastOk) / 60000) : null;
  return `${st.nickname} (${st.role}) · ${st.lastOk ? (mins !== null && mins < 1 ? 'только что' : `${mins} мин назад`) : 'ещё не синкался'}`;
}
