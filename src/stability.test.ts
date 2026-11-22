import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Entry } from './db';
import { loadSync, pauseSync, registerDevice, resumeSync, runSync, saveSync, type SyncSettings } from './sync';
import { exportJSON, importJSONText, wipeAll } from './data-transfer';
import { adaptiveTdee } from './store';

const settings: SyncSettings = {
  server: 'http://localhost:8689', token: 'synthetic', userId: 'user-a', role: 'admin',
  nickname: 'A', since: 0, lastPush: 0, lastOk: 0,
};

const makeEntry = (id: string, grams = 100): Entry => ({
  id, userId: 'local', date: '2026-11-22', slotId: 'slot-breakfast', timeEaten: '08:00',
  kind: 'food', refId: 'b001', grams, unit: 'g', createdAt: 10, updatedAt: 10,
  deletedAt: null, snapshot: { kcal: grams, p: 0, f: 0, c: 0 },
});

type RequestBody = { pull: boolean; cursor: { applied: number }; changes: Array<{ kind: string; body: Entry }> };

function stubServer(reply: (request: RequestBody) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as RequestBody;
    const overrides = await reply(request);
    return Response.json({ changes: [], serverTime: 100, maxUpdated: 100,
      cursor: { applied: 100, kind: '', id: '', owner: '' }, hasMore: false,
      applied: request.changes.length, rejected: 0, results: request.changes.map(() => 'applied'), ...overrides });
  }));
}

beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {});
  await db.delete();
  await db.open();
  await db.foods.clear();
  await db.slots.clear();
  saveSync(settings);
});

afterEach(async () => {
  await db.delete();
  vi.unstubAllGlobals();
});

describe('stable synchronisation', () => {
  it('retries an interrupted batch and sends all records with equal versions', async () => {
    await db.entries.bulkAdd(Array.from({ length: 2001 }, (_, i) => makeEntry(String(i))));
    const sent: string[][] = [];
    let push = 0;
    stubServer(request => {
      if (request.changes.length) {
        sent.push(request.changes.map(change => change.body.id));
        if (++push === 2) throw new Error('connection lost');
      }
      return {};
    });
    expect(await runSync()).toMatchObject({ ok: false, pushed: 1000 });
    expect(loadSync()?.lastOk).toBe(0);
    expect(await runSync()).toMatchObject({ ok: true, pushed: 1001 });
    expect(sent.map(batch => batch.length)).toEqual([1000, 1000, 1000, 1]);
    expect(sent[2]).toEqual(sent[1]);
    expect(new Set([...sent[0], ...sent[2], ...sent[3]])).toHaveProperty('size', 2001);
  }, 20000);

  it('pulls all pages and preserves an edit made while sending the old version', async () => {
    await db.entries.add(makeEntry('local-edit'));
    let pushedEdit = false;
    let pull = 0;
    const sent: number[] = [];
    stubServer(async request => {
      if (request.changes.length) {
        sent.push(request.changes[0].body.grams);
        if (!pushedEdit) {
          await db.entries.update('local-edit', { grams: 150, updatedAt: 10 });
          pushedEdit = true;
        }
      }
      if (!request.pull) return { cursor: request.cursor };
      if (++pull === 1) {
        return { changes: [{ kind: 'entries', body: makeEntry('local-edit'), updated: 10 }],
          hasMore: true, cursor: { applied: 50, kind: 'entries', id: 'local-edit', owner: 'user-a' } };
      }
      if (pull === 2) {
        expect(request.cursor.applied).toBe(50);
        return { changes: [{ kind: 'entries', body: makeEntry('last-page'), updated: 10 }] };
      }
      return {};
    });
    expect((await runSync()).ok).toBe(true);
    expect(await db.entries.get('last-page')).toBeDefined();
    expect((await db.entries.get('local-edit'))?.grams).toBe(150);
    expect((await runSync()).ok).toBe(true);
    expect(sent).toEqual([100, 150]);
  });

  it('keeps a rejected record pending while remembering accepted records', async () => {
    await db.entries.bulkAdd([makeEntry('a'), makeEntry('b')]);
    const attempts: string[][] = [];
    stubServer(request => {
      if (!request.changes.length) return {};
      attempts.push(request.changes.map(change => change.body.id));
      return attempts.length === 1 ? { applied: 1, rejected: 1, results: ['applied', 'rejected'] } : {};
    });
    expect((await runSync()).ok).toBe(false);
    expect((await runSync()).ok).toBe(true);
    expect(attempts).toEqual([['a', 'b'], ['b']]);
  });

  it('pauses and resumes the same account and rejects a different account', () => {
    expect(pauseSync()?.userId).toBe(settings.userId);
    expect(loadSync()).toBeNull();
    expect(() => saveSync({ ...settings, userId: 'user-b' })).toThrow();
    expect(resumeSync()?.userId).toBe(settings.userId);
  });
});

describe('local data recovery', () => {
  it('loads no rows if a later archive section is invalid, and restores normal archives', async () => {
    const malformed = { app: 'deep-dish', version: 1, entries: [makeEntry('partial')],
      weightLogs: [{ weightKg: 75 }] };
    await expect(importJSONText(JSON.stringify(malformed))).rejects.toThrow();
    expect(await db.entries.count()).toBe(0);
    const entry = makeEntry('saved');
    await db.entries.add(entry);
    await db.dayNormas.put({ date: entry.date, kcal: 2000, p: 100, f: 60, c: 250,
      createdAt: 20, basis: 'formula', detail: {} });
    await db.slotMarks.put({ id: 'mark', date: entry.date, slotId: entry.slotId, userId: 'local',
      untracked: true, createdAt: 20, updatedAt: 20, deletedAt: null });
    const backup = await (await exportJSON()).text();
    await wipeAll();
    expect(loadSync()).toBeNull();
    expect(await db.entries.count()).toBe(0);
    expect(await db.slots.count()).toBe(4);
    await importJSONText(backup);
    expect(await db.entries.get(entry.id)).toEqual(entry);
    expect((await db.dayNormas.get(entry.date))?.kcal).toBe(2000);
    expect((await db.slotMarks.get('mark'))?.untracked).toBe(true);
    expect(JSON.parse(await (await exportJSON()).text()).owner.userId).toBe(settings.userId);
    await expect(registerDevice(settings.server, 'Another participant')).rejects.toThrow('семейный дневник');
    expect(() => saveSync({ ...settings, userId: 'user-b' })).toThrow();
  });

  it('prevents mixing archives from different accounts and keeps a newer local row', async () => {
    const old = { app: 'deep-dish', version: 2, owner: { server: settings.server, userId: 'user-b' },
      entries: [makeEntry('edit')] };
    await expect(importJSONText(JSON.stringify(old))).rejects.toThrow('другому');
    await db.entries.put({ ...makeEntry('edit', 120), updatedAt: 20 });
    await importJSONText(JSON.stringify({ ...old, owner: { ...old.owner, userId: settings.userId } }));
    expect((await db.entries.get('edit'))?.grams).toBe(120);
  });
});

it('uses the logged days for average intake and excludes weights after the calculation date', () => {
  const intake = new Map(Array.from({ length: 21 }, (_, index) =>
    [`2026-11-${String(index + 1).padStart(2, '0')}`, 2200]));
  const weights = [{ date: '2026-11-01', kg: 80 }, { date: '2026-11-28', kg: 79 }, { date: '2026-11-29', kg: 90 }];
  const result = adaptiveTdee(weights, intake, '2026-11-28');
  expect(result).toMatchObject({ from: '2026-11-01', to: '2026-11-28', coverage: 0.75, intakeAvg: 2200, weightDelta: -1 });
  expect(result?.tdee).toBe(2475);
});
