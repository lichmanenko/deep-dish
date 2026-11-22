import type { Table } from 'dexie';
import { db, LOCAL_USER, type MetricEvent, type SyncReceipt } from './db';
import { track } from './store';

interface PullCursor {
  applied: number;
  kind: string;
  id: string;
  owner: string;
}

const START_CURSOR: PullCursor = { applied: 0, kind: '', id: '', owner: '' };
const PUSH_SIZE = 1000;
const EVENTS_SIZE = 500;
const LEGACY_PULL_SIZE = 5000;
const AUTO_INTERVAL = 5 * 60 * 1000;

export interface SyncSettings {
  server: string;
  userId: string;
  token: string;
  nickname: string;
  role: 'admin' | 'member';
  since: number;
  cursor?: PullCursor;
  lastPush: number;
  lastOk: number;
}

const ACTIVE_KEY = 'dd-sync';
const PAUSED_KEY = 'dd-paused-sync';
const OWNER_KEY = 'dd-data-owner';

type Row = Record<string, unknown>;
const REPLICAS = {
  foods: db.foods, recipes: db.recipes, slots: db.slots, entries: db.entries,
  weightLogs: db.weightLogs, dayNormas: db.dayNormas, slotMarks: db.slotMarks,
  savedMeals: db.savedMeals, profiles: db.profiles, achievements: db.achievements,
};
type Kind = keyof typeof REPLICAS;
const KINDS = Object.keys(REPLICAS) as Kind[];
const PRIVATE = new Set<Kind>(['slots', 'entries', 'weightLogs', 'dayNormas', 'slotMarks', 'savedMeals', 'profiles']);
const TABLES = KINDS.map(kind => REPLICAS[kind]);

function tableFor(kind: Kind): Table<Row, string> {
  return REPLICAS[kind] as unknown as Table<Row, string>;
}

function isKind(value: string): value is Kind {
  return Object.hasOwn(REPLICAS, value);
}

function keyFor(kind: Kind, row: Row): string | undefined {
  const key = kind === 'dayNormas' ? row.date : kind === 'profiles' ? LOCAL_USER : row.id;
  return typeof key === 'string' && key ? key : undefined;
}

function receiptKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

function trimServer(address: string): string {
  return address.trim().replace(/\/+$/, '');
}

type DiaryOwner = Pick<SyncSettings, 'server' | 'userId'>;

function scopeFor(owner: DiaryOwner): string {
  return JSON.stringify([trimServer(owner.server), owner.userId]);
}

export function loadDiaryOwner(): DiaryOwner | null {
  const saved = localStorage.getItem(OWNER_KEY);
  if (saved) {
    const [server, userId] = JSON.parse(saved);
    return { server, userId };
  }
  const settings = loadSync() ?? loadPausedSync();
  return settings ? { server: settings.server, userId: settings.userId } : null;
}

export function bindDiary(owner: DiaryOwner) {
  const scope = scopeFor(owner);
  const current = loadDiaryOwner();
  if (current && scopeFor(current) !== scope) {
    throw new Error('Этот дневник привязан к другому участнику. Перед сменой участника сохраните копию дневника и очистите данные на устройстве.');
  }
  localStorage.setItem(OWNER_KEY, scope);
}

function readSettings(key: string): SyncSettings | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadSync(): SyncSettings | null {
  return readSettings(ACTIVE_KEY);
}

export function loadPausedSync(): SyncSettings | null {
  return readSettings(PAUSED_KEY);
}

export function saveSync(settings: SyncSettings | null) {
  if (!settings) {
    localStorage.removeItem(ACTIVE_KEY);
    window.dispatchEvent(new Event('dd-sync-changed'));
    return;
  }
  bindDiary(settings);
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('dd-sync-changed'));
}

export function pauseSync(): SyncSettings | null {
  const settings = loadSync();
  if (settings) {
    saveSync(settings);
    localStorage.setItem(PAUSED_KEY, JSON.stringify(settings));
    saveSync(null);
  }
  return settings;
}

export function resumeSync(): SyncSettings | null {
  const settings = loadPausedSync();
  if (settings) {
    saveSync(settings);
    localStorage.removeItem(PAUSED_KEY);
  }
  return settings;
}

export function forgetSync() {
  saveSync(null);
  localStorage.removeItem(PAUSED_KEY);
  localStorage.removeItem(OWNER_KEY);
  localStorage.removeItem('dd-hcode');
}

export async function registerDevice(server: string, nickname: string, invitation?: string): Promise<SyncSettings> {
  if (loadDiaryOwner()) {
    throw new Error('На этом устройстве уже есть семейный дневник. Возобновите прежнее подключение.');
  }
  const base = trimServer(server);
  const address = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.username || address.password || address.search || address.hash
      || (address.protocol !== 'https:' && !(local && address.protocol === 'http:'))) {
    throw new Error('Укажите HTTPS-адрес семейного сервера.');
  }
  const res = await fetch(base + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, inviteCode: invitation }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) {
    const result = await res.json().catch(() => null);
    throw new Error(typeof result?.detail === 'string' ? result.detail : 'Сервер отклонил подключение.');
  }
  const r = await res.json();
  return { server: base, userId: r.userId, token: r.token, nickname, role: r.role, since: 0, lastPush: 0, lastOk: 0 };
}

export interface SyncResult { ok: boolean; pushed: number; pulled: number; error?: string }

interface WireChange {
  kind: string;
  body: Row;
  updated: number;
}

interface PendingChange {
  kind: Kind;
  id: string;
  body: Row;
  fingerprint: string;
  updatedAt: number;
  baseUpdated?: number;
}

interface SyncResponse {
  changes: WireChange[];
  corrections?: WireChange[];
  results?: string[];
  serverTime: number;
  maxUpdated?: number;
  cursor?: PullCursor;
  hasMore?: boolean;
  applied?: number;
  rejected?: number;
}

function ownWritable(kind: Kind, row: Row, settings: SyncSettings): boolean {
  if (PRIVATE.has(kind)) return true;
  if (kind === 'achievements') return row.userId === LOCAL_USER || row.userId === settings.userId;
  return !row.ownerId || [LOCAL_USER, 'system', settings.userId].includes(String(row.ownerId));
}

function localVersion(kind: Kind, row: Row): number {
  const value = row.updatedAt ?? (kind === 'dayNormas' ? row.createdAt : undefined);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeIncoming(change: WireChange, settings: SyncSettings): Row {
  const body = { ...change.body, updatedAt: change.updated };
  if (isKind(change.kind) && PRIVATE.has(change.kind)) {
    return { ...body, userId: LOCAL_USER };
  }
  if (change.kind === 'achievements' && change.body.userId === settings.userId) {
    return { ...body, userId: LOCAL_USER };
  }
  return body;
}

function assertActive(settings: SyncSettings) {
  const active = loadSync();
  if (!active || scopeFor(active) !== scopeFor(settings) || active.token !== settings.token) {
    throw new Error('Подключение изменилось во время синхронизации.');
  }
}

async function exchange(settings: SyncSettings, since: number, cursor: PullCursor,
                        pending: PendingChange[], events: MetricEvent[], pull: boolean): Promise<SyncResponse> {
  assertActive(settings);
  const response = await fetch(trimServer(settings.server) + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.token },
    body: JSON.stringify({
      since, cursor, pull, client_now: Date.now(),
      changes: pending.map(({ kind, body, baseUpdated }) => ({ kind, body, baseUpdated })),
      events: events.map(({ id, ts, name, props }) => ({ id, ts, name, props })),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Сервер не принял ключ подключения.' : `сервер ответил ${response.status}`);
  }
  const result = await response.json();
  if (!Array.isArray(result.changes) || !Number.isSafeInteger(result.serverTime)) {
    throw new Error('Сервер вернул неполный результат синхронизации.');
  }
  assertActive(settings);
  return result;
}

async function gatherChanges(settings: SyncSettings, modern: boolean, force: boolean) {
  const scope = scopeFor(settings);
  const floor = settings.lastPush > Date.now() ? 0
    : Math.max(0, settings.lastPush - (force ? 7 * 86400000 : 0));
  return db.transaction('r', [...TABLES, db.syncReceipts, db.events], async () => {
    const saved = await db.syncReceipts.where('scope').equals(scope).toArray();
    const receipts = new Map(saved.map(receipt => [receiptKey(receipt.kind, receipt.id), receipt]));
    const changes: PendingChange[] = [];
    for (const kind of KINDS) {
      if (!modern && (kind === 'dayNormas' || kind === 'slotMarks')) continue;
      for (const row of await tableFor(kind).toArray()) {
        const id = keyFor(kind, row);
        const updatedAt = localVersion(kind, row);
        if (!id || !updatedAt || !ownWritable(kind, row, settings)) continue;
        if (kind === 'foods' && row.deletedAt && row.delBy !== 'user') continue;
        const fingerprint = JSON.stringify(row);
        const receipt = receipts.get(receiptKey(kind, id));
        if (receipt?.fingerprint === fingerprint || (!modern && !receipt && updatedAt <= floor && kind !== 'profiles')) continue;
        changes.push({ kind, id, fingerprint, updatedAt, baseUpdated: receipt?.updatedAt, body: { ...row, updatedAt } });
      }
    }
    const events = (await db.events.orderBy('ts').toArray())
      .filter(event => !receipts.has(receiptKey('events', event.id)));
    return { changes, events };
  });
}

async function recordPush(settings: SyncSettings, result: SyncResponse,
                          changes: PendingChange[], events: MetricEvent[]): Promise<number> {
  const scope = scopeFor(settings);
  const rejects = result.rejected ?? 0;
  const statuses = result.results;
  if (statuses && statuses.length !== changes.length) throw new Error('Сервер подтвердил неполную пачку.');
  const corrections = new Map<string, WireChange>();
  for (const correction of result.corrections ?? []) {
    if (!isKind(correction.kind)) continue;
    const id = keyFor(correction.kind, correction.body);
    if (id) corrections.set(receiptKey(correction.kind, id), correction);
  }
  await db.transaction('rw', [...TABLES, db.syncReceipts], async () => {
    const receipts: SyncReceipt[] = [];
    assertActive(settings);
    for (const [index, change] of changes.entries()) {
      const status = statuses?.[index];
      if (statuses ? status !== 'applied' && status !== 'current' : rejects > 0) continue;
      const correction = corrections.get(receiptKey(change.kind, change.id));
      let { fingerprint, updatedAt } = change;
      if (correction) {
        const table = tableFor(change.kind);
        const local = await table.get(change.id);
        if (local && JSON.stringify(local) === fingerprint) {
          const canonical = normalizeIncoming(correction, settings);
          await table.put(canonical);
          fingerprint = JSON.stringify(canonical);
          updatedAt = correction.updated;
        } else {
          updatedAt = change.baseUpdated ?? 0;
        }
      }
      receipts.push({ scope, kind: change.kind, id: change.id, fingerprint, updatedAt });
    }
    receipts.push(...events.map(event => ({ scope, kind: 'events', id: event.id, fingerprint: '', updatedAt: event.ts })));
    await db.syncReceipts.bulkPut(receipts);
    assertActive(settings);
  });
  return result.applied ?? changes.length - rejects;
}

async function applyPage(settings: SyncSettings, result: SyncResponse): Promise<number> {
  const scope = scopeFor(settings);
  return db.transaction('rw', [...TABLES, db.syncReceipts], async () => {
    assertActive(settings);
    let written = 0;
    for (const change of result.changes) {
      if (!isKind(change.kind)) continue;
      const kind = change.kind;
      const body = normalizeIncoming(change, settings);
      const id = keyFor(kind, body);
      if (!id) continue;
      const table = tableFor(kind);
      const local = await table.get(id);
      const receipt = await db.syncReceipts.get([scope, kind, id]);
      if (local && ownWritable(kind, local, settings) && JSON.stringify(local) !== receipt?.fingerprint) {
        const staleLegacyTombstone = kind === 'foods' && local.deletedAt && local.delBy !== 'user';
        const legacyAlreadySent = !result.cursor && !receipt && localVersion(kind, local) <= settings.lastPush;
        if (!staleLegacyTombstone && !legacyAlreadySent) continue;
      }
      await table.put(body);
      await db.syncReceipts.put({ scope, kind, id, fingerprint: JSON.stringify(body), updatedAt: change.updated });
      written++;
    }
    assertActive(settings);
    return written;
  });
}

let syncQueue = Promise.resolve();

function serializedSync(action: () => Promise<SyncResult>): Promise<SyncResult> {
  const run = syncQueue.then(async () => navigator.locks
    ? await navigator.locks.request('deepdish-sync', action)
    : action());
  syncQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function syncOnce(force: boolean, reset: boolean): Promise<SyncResult> {
  const settings = loadSync();
  if (!settings) return { ok: false, pushed: 0, pulled: 0, error: 'синхронизация не настроена' };
  saveSync(settings);
  const startedAt = Date.now();
  let since = settings.since, cursor = settings.cursor ?? START_CURSOR;
  let pushed = 0, pulled = 0, rejected = 0;
  try {
    const probe = await exchange(settings, since, cursor, [], [], false);
    const modern = Boolean(probe.cursor);
    if (probe.cursor) cursor = probe.cursor;
    const { changes, events } = await gatherChanges(settings, modern, force);
    for (let offset = 0, eventOffset = 0; offset < changes.length || eventOffset < events.length;
         offset += PUSH_SIZE, eventOffset += EVENTS_SIZE) {
      const batch = changes.slice(offset, offset + PUSH_SIZE);
      const eventBatch = events.slice(eventOffset, eventOffset + EVENTS_SIZE);
      const response = await exchange(settings, since, cursor, batch, eventBatch, false);
      pushed += await recordPush(settings, response, batch, eventBatch);
      rejected += response.rejected ?? 0;
    }
    if (reset && !rejected) {
      since = 0;
      cursor = START_CURSOR;
    }

    let more: boolean;
    do {
      const response = await exchange(settings, since, cursor, [], [], true);
      pulled += await applyPage(settings, response);
      const nextSince = response.maxUpdated ?? response.serverTime;
      const nextCursor = response.cursor ?? START_CURSOR;
      more = response.hasMore ?? (response.changes.length >= LEGACY_PULL_SIZE && nextSince < response.serverTime);
      const stalled = response.cursor ? JSON.stringify(nextCursor) === JSON.stringify(cursor) : nextSince === since;
      if (more && stalled) throw new Error('Сервер не смог продолжить выдачу записей.');
      since = nextSince;
      cursor = nextCursor;
      assertActive(settings);
      saveSync({ ...settings, since, cursor: response.cursor });
    } while (more);

    const now = Date.now();
    const lastPush = rejected ? settings.lastPush : Math.max(0, Math.min(now, startedAt) - 1);
    const current = loadSync()!;
    saveSync({ ...current, lastPush, lastOk: rejected ? settings.lastOk : now });
    track('sync_result', { pushed, pulled, rejected, rejectedByServer: rejected,
      sent: changes.length, localPendingBeforeSync: changes.length, skewMs: probe.serverTime - startedAt });
    return { ok: !rejected, pushed, pulled, error: rejected ? `сервер отклонил записей: ${rejected}. Они остались на устройстве.` : undefined };
  } catch (error) {
    const message = (error as Error).message;
    track('sync_fail', { msg: message.slice(0, 90), since });
    return { ok: false, pushed, pulled, error: message };
  }
}

export function runSync(force = false): Promise<SyncResult> {
  return serializedSync(() => syncOnce(force, false));
}

export function fullReload(): Promise<SyncResult> {
  return serializedSync(() => syncOnce(true, true));
}

let lastAuto = 0;
export function autoSync(reconnected = false) {
  if (!loadSync() || !navigator.onLine || document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (!reconnected && now - lastAuto < AUTO_INTERVAL && now >= lastAuto) return;
  lastAuto = now;
  void runSync().catch(() => {});
}

export function syncStatusText(settings = loadSync()): string {
  if (!settings) return 'Синхронизация не настроена';
  if (!settings.lastOk) return `${settings.nickname} · синхронизации ещё не было`;
  const date = new Date(settings.lastOk);
  const h = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `${settings.nickname} · обновлено сегодня в ${h}`
    : `${settings.nickname} · обновлено ${date.toLocaleDateString('ru-RU')} в ${h}`;
}
