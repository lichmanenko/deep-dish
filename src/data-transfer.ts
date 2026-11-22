import type { Table } from 'dexie';
import { db, LOCAL_USER, seedCatalogAndSlots } from './db';
import { bindDiary, forgetSync, loadDiaryOwner, pauseSync, resumeSync } from './sync';
import { getSlots, track } from './store';

// ── Экспорт ──
const ARCHIVE_TABLES = {
  foods: db.foods, recipes: db.recipes, savedMeals: db.savedMeals, slots: db.slots,
  entries: db.entries, weightLogs: db.weightLogs, dayNormas: db.dayNormas,
  profiles: db.profiles, slotMarks: db.slotMarks, achievements: db.achievements,
};

export async function exportJSON(): Promise<Blob> {
  const owner = loadDiaryOwner() ?? undefined;
  const tables = Object.entries(ARCHIVE_TABLES);
  const contents = await db.transaction('r', Object.values(ARCHIVE_TABLES), async () =>
    Object.fromEntries(await Promise.all(tables.map(async ([name, table]) => [name, await table.toArray()]))));
  const dump = { app: 'deep-dish', version: 2, exportedAt: new Date().toISOString(), owner, ...contents };
  return new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
}

export async function exportCSV(): Promise<Blob> {
  const slots = await getSlots();
  const slotName = new Map(slots.map(s => [s.id, s.name]));
  const foods = await db.foods.toArray(); const recipes = await db.recipes.toArray();
  const byFood = new Map(foods.map(food => [food.id, food]));
  const byRecipe = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const es = (await db.entries.filter(e => !e.deletedAt).toArray())
    .sort((a, b) => a.date.localeCompare(b.date) || a.timeEaten.localeCompare(b.timeEaten));
  const cell = (value: string | number) => {
    let text = String(value);
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return /[;"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  const rows = ['дата;время;приём;блюдо;количество;единица;ккал;белки;жиры;углеводы'];
  for (const entry of es) {
    const product = (entry.kind === 'food' ? byFood : byRecipe).get(entry.refId);
    const unit = entry.unit ?? product?.unit ?? 'g';
    rows.push([entry.date, entry.timeEaten, slotName.get(entry.slotId) ?? '', product?.name ?? entry.refId,
      unit === 'pc' ? entry.grams / 100 : entry.grams, unit === 'pc' ? 'шт' : 'г',
      entry.snapshot.kcal, entry.snapshot.p, entry.snapshot.f, entry.snapshot.c].map(cell).join(';'));
  }
  return new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv' });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  track('export_done', { name });
}

export async function wipeAll() {
  const wasActive = pauseSync();
  try {
    await db.transaction('rw', db.tables, async tx => {
      await Promise.all(db.tables.map(table => table.clear()));
      await seedCatalogAndSlots(tx);
    });
    forgetSync();
  } catch (error) {
    if (wasActive) resumeSync();
    throw error;
  }
}

// ── Импорт JSON (восстановление бэкапа) ───────────────────────────────────────

export async function importJSONText(text: string, mode: 'archive' | 'catalog' = 'archive'): Promise<Record<string, number>> {
  const d = JSON.parse(text) as Record<string, unknown>;
  if (d?.app !== 'deep-dish') throw new Error('это не бэкап Deep Dish');
  if (d.version !== undefined && d.version !== 1 && d.version !== 2) throw new Error('версия файла не поддерживается');
  let owner: { server: string; userId: string } | undefined;
  if (mode === 'archive' && d.owner !== undefined) {
    const saved = d.owner as { server?: unknown; userId?: unknown } | null;
    if (typeof saved?.server !== 'string' || !saved.server || typeof saved.userId !== 'string' || !saved.userId) {
      throw new Error('в архиве повреждена привязка семейного дневника');
    }
    owner = { server: saved.server.trim().replace(/\/+$/, ''), userId: saved.userId };
    const current = loadDiaryOwner();
    if (current && (owner.userId !== current.userId || owner.server !== current.server.replace(/\/+$/, ''))) {
      throw new Error('архив принадлежит другому семейному дневнику');
    }
  }
  const tables = mode === 'catalog' ? { foods: db.foods, recipes: db.recipes } : ARCHIVE_TABLES;
  const validated = Object.entries(tables).flatMap(([name, dbTable]) => {
    const value = d[name];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`раздел «${name}» имеет неправильный формат`);
    const key = name === 'profiles' ? 'userId' : name === 'dayNormas' ? 'date' : 'id';
    const rows = value.map((row: Record<string, unknown>) => {
      if (!row || typeof row !== 'object' || typeof row[key] !== 'string' || !row[key]) {
        throw new Error(`в разделе «${name}» есть запись без идентификатора`);
      }
      const snapshot = row.snapshot as Record<string, unknown> | undefined;
      if (name === 'entries' && (!snapshot || !Number.isFinite(row.grams)
          || !['kcal', 'p', 'f', 'c'].every(field => Number.isFinite(snapshot[field]))
          || !['date', 'timeEaten', 'slotId', 'refId'].every(field => typeof row[field] === 'string'))) {
        throw new Error('в дневнике есть запись без количества или КБЖУ');
      }
      if ((name === 'foods' || name === 'recipes') && (typeof row.name !== 'string'
        || !['kcalPer100g', 'pPer100g', 'fPer100g', 'cPer100g'].every(field => Number.isFinite(row[field])))) {
        throw new Error(`в разделе «${name}» есть запись без названия или КБЖУ`);
      }
      if ((name === 'recipes' || name === 'savedMeals') && !Array.isArray(row.items)) {
        throw new Error(`в разделе «${name}» отсутствуют ингредиенты`);
      }
      return ['entries', 'weightLogs', 'slotMarks', 'profiles'].includes(name) ? { ...row, userId: LOCAL_USER } : row;
    });
    return [{ name, key, table: dbTable as unknown as Table<Record<string, unknown>, string>, rows }];
  });
  const counts = await db.transaction('rw', Object.values(tables), async () => {
    const applied: Record<string, number> = {};
    for (const { name, key, table, rows } of validated) {
      const present = await table.bulkGet(rows.map(row => String(row[key])));
      const incoming = rows.filter((row, index) => Number(row.updatedAt ?? row.createdAt ?? 0)
        >= Number(present[index]?.updatedAt ?? present[index]?.createdAt ?? 0));
      await table.bulkPut(incoming);
      if (incoming.length) applied[name] = incoming.length;
    }
    if (owner) bindDiary(owner);
    return applied;
  });
  track('import_json', counts);
  return counts;
}
