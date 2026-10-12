#!/usr/bin/env node
// Конвертер выгрузок MyFitnessPal в JSON-бэкап Deep Dish.
// Запускается агентом, вне приложения (решение В. 06.10: импорт MFP — «здесь», не в UI).
//
//   node tools/mfp2dd.mjs <путь> [backup.json] [-o out.json]
//
//   <путь>       — CSV или ПАПКА выгрузки MFP. Поддержаны форматы:
//                  1) «Экспорт за период» (веб, рус. локаль): «Статистика по питанию» —
//                     итоги приёма без названий блюд (+ рядом «по показателям» — вес);
//                  2) полный экспорт Account Settings → Export Data (food.csv): строки-блюда.
//                  Для папки файлы ищутся по именам (питание/food, показателям/measurement).
//   backup.json  — необязательно: текущий экспорт Deep Dish. Если задан, записи DD
//                  в диапазоне дат выгрузки заменяются импортируемыми (без дублей),
//                  остальное проходит как есть; вес мерджится по дате.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { argv, exit } from 'node:process';

const SLOT_DEFAULTS = { breakfast: ['slot-breakfast', '08:00'], lunch: ['slot-lunch', '13:00'], dinner: ['slot-dinner', '19:00'] };
const KEYWORDS = JSON.parse(readFileSync(new URL('../data/category-keywords.json', import.meta.url), 'utf-8'));

// ── утилиты (паритет с приложением) ──
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Даты MFP: YYYY-MM-DD (экспорт за период, рус. локаль), MM/DD/YYYY, DD/MM/YYYY
function mfpDate(raw) {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) { const p = n => n.padStart(2, '0'); return `${iso[1]}-${p(iso[2])}-${p(iso[3])}`; }
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m) return '';
  let a = m[1], b = m[2];
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  if (parseInt(a, 10) > 12 && parseInt(b, 10) <= 12) { const t = a; a = b; b = t; }
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(a)}-${p(b)}`;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  for (const { cat, words } of KEYWORDS) if (words.some(w => n.includes(w))) return cat;
  return 'Импорт MFP';
}

function slotKeyOf(mealRaw) {
  return /breakfast|завтрак/i.test(mealRaw) ? 'breakfast'
    : /lunch|обед/i.test(mealRaw) ? 'lunch'
    : /dinner|ужин/i.test(mealRaw) ? 'dinner' : 'snack';
}

function uuid() { return crypto.randomUUID(); }
const num = s => parseFloat(String(s ?? '').replace(',', '.')) || 0;
const r1 = v => Math.round(v * 10) / 10;

// ── разбор CSV питания: детальный (блюда) или агрегатный (итоги приёма) ──
// строки результата: { date, slotKey, name?, kcal, p, f, c } — name есть только в детальном
function parseMeals(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('в файле нет строк с едой');
  const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const ci = {
    date: col('date', 'дата'), meal: col('meal', 'прием пищи', 'приём пищи'),
    name: col('food name', 'food', 'блюдо', 'название'),
    brand: col('brand', 'производитель'),
    kcal: col('calories', 'ккал', 'калор'),
    f: col('fat', 'жир'), c: col('carbohydrate', 'carbs', 'углев'), p: col('protein', 'белк', 'протеин'),
  };
  if (ci.date < 0 || ci.kcal < 0) throw new Error('не нашёл колонки «дата/калории» — это точно выгрузка MFP?');
  const detailed = ci.name >= 0;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const date = mfpDate(c[ci.date] ?? '');
    if (!date) continue;
    const slotKey = slotKeyOf(ci.meal >= 0 ? (c[ci.meal] ?? '') : '');
    const base = { date, slotKey,
      kcal: num(c[ci.kcal]), p: ci.p >= 0 ? num(c[ci.p]) : 0,
      f: ci.f >= 0 ? num(c[ci.f]) : 0, c: ci.c >= 0 ? num(c[ci.c]) : 0 };
    if (detailed) {
      const name = c[ci.name] ?? '';
      if (!name) continue;
      rows.push({ ...base, name, brand: ci.brand >= 0 ? (c[ci.brand] ?? '') : '' });
    } else {
      rows.push(base); // агрегат приёма целиком
    }
  }
  if (!rows.length) throw new Error('не распознана ни одна строка');
  return { detailed, rows };
}

// ── разбор CSV показателей (вес) ──
function parseWeight(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const d = head.findIndex(h => h.includes('дата') || h.includes('date'));
  const w = head.findIndex(h => h.includes('вес') || h.includes('weight'));
  if (d < 0 || w < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const date = mfpDate(c[d] ?? '');
    const kg = num(c[w]);
    if (date && kg > 0) out.push({ date, kg });
  }
  return out;
}

// ── CLI ──
const args = argv.slice(2);
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const untilIdx = args.indexOf('--until');
const until = untilIdx >= 0 ? args.splice(untilIdx, 2)[1] : null; // YYYY-MM-DD, включительно
let [srcPath, backupPath] = args;
if (!srcPath) { console.error('node tools/mfp2dd.mjs <выгрузка.csv | папка> [backup.json] [-o out.json]'); exit(1); }

// папка → найти файлы питания и веса; иначе один файл
let mealsPath = srcPath, weightPath = null;
if (statSync(srcPath).isDirectory()) {
  const files = readdirSync(srcPath);
  mealsPath = files.find(f => /питани|food/i.test(f) && f.endsWith('.csv'));
  weightPath = files.find(f => /показател|measurement/i.test(f) && f.endsWith('.csv')) ?? null;
  if (!mealsPath) throw new Error('в папке нет CSV питания (ищу «…питани….csv» / food.csv)');
  const dir = srcPath.replace(/[\\/]+$/, '');
  mealsPath = `${dir}/${mealsPath}`;
  if (weightPath) weightPath = `${dir}/${weightPath}`;
  const skipped = files.filter(f => f.endsWith('.csv') && f !== mealsPath.split('/').pop() && f !== (weightPath?.split('/').pop() ?? ''));
  if (skipped.length) console.log(`Папка: питание="${mealsPath.split('/').pop()}"${weightPath ? `, вес="${weightPath.split('/').pop()}"` : ''}; пропущено: ${skipped.join(', ')}`);
}

const parsed = parseMeals(readFileSync(mealsPath, 'utf-8'));
const rows = until ? parsed.rows.filter(r => r.date <= until) : parsed.rows;
const { detailed } = parsed;
let weights = weightPath ? parseWeight(readFileSync(weightPath, 'utf-8')) : [];
if (until) weights = weights.filter(w => w.date <= until);
const dates = rows.map(r => r.date).sort();
const from = dates[0], to = dates[dates.length - 1];

const backup = backupPath ? JSON.parse(readFileSync(backupPath, 'utf-8')) : null;
if (backupPath && backup?.app !== 'deep-dish') throw new Error('backup.json — не бэкап Deep Dish');

const foods = backup?.foods ? [...backup.foods] : [];
const backupEntries = backup?.entries ?? [];
const byKey = new Map(foods.map(f => [`${f.name.toLowerCase().trim()}|${(f.brand ?? '').toLowerCase().trim()}`, f]));
const now = Date.now();
const replaced = new Set(backupEntries.filter(e => !e.deletedAt && e.date >= from && e.date <= to).map(e => e.id));
// Замена диапазона: тестовые записи DD за даты выгрузки НЕ выбрасываются из файла, а помечаются
// удалёнными (tombstone). Импорт делает bulkPut по id → запись перезапишется удалённой, дублей
// не останется; при необходимости восстановима агентом (снятым пометки).
const finalBackupEntries = backupEntries.map(e =>
  (replaced.has(e.id) && !e.deletedAt) ? { ...e, deletedAt: now, updatedAt: now } : e);

let madeFoods = 0, reused = 0;
const importedEntries = [];

// агрегатный формат: по одному порционному продукту на тип приёма, КБЖУ — снапшотом записи
const MEAL_FOOD = { breakfast: 'Завтрак (MFP)', lunch: 'Обед (MFP)', dinner: 'Ужин (MFP)', snack: 'Перекус (MFP)' };

const foodFor = r => {
  if (!detailed) {
    const nm = MEAL_FOOD[r.slotKey];
    let f = byKey.get(`${nm.toLowerCase()}|`);
    if (f) return f;
    f = { id: uuid(), name: nm, brand: undefined, category: 'Импорт MFP',
      kcalPer100g: r.kcal, pPer100g: r.p, fPer100g: r.f, cPer100g: r.c,
      unit: 'pc', source: 'mfp', ownerId: 'local', isPublic: false, hidden: true,
      createdAt: now, updatedAt: now, deletedAt: null };
    byKey.set(`${nm.toLowerCase()}|`, f); foods.push(f); madeFoods++;
    return f;
  }
  const key = `${r.name.toLowerCase().trim()}|${(r.brand ?? '').toLowerCase().trim()}`;
  let f = byKey.get(key);
  if (!f) {
    f = { id: uuid(), name: r.name, brand: r.brand || undefined, category: guessCategory(r.name),
      kcalPer100g: r.kcal, pPer100g: r.p, fPer100g: r.f, cPer100g: r.c,
      unit: 'pc', source: 'mfp', ownerId: 'local', isPublic: false,
      createdAt: now, updatedAt: now, deletedAt: null };
    byKey.set(key, f); foods.push(f); madeFoods++;
  } else reused++;
  return f;
};

for (const r of rows) {
  const f = foodFor(r);
  const [slotId, defTime] = SLOT_DEFAULTS[r.slotKey] ?? ['slot-snack', '12:00'];
  // граммовки в выгрузках MFP нет: строка/приём = порция (граммы 100 в условных единицах)
  // timeApprox: время фиктивное (слот), детектор «окон срыва» такие записи не учитывает
  importedEntries.push({ id: uuid(), userId: 'local', date: r.date, timeEaten: defTime, timeApprox: true, slotId,
    kind: 'food', refId: f.id, grams: 100,
    snapshot: { kcal: Math.round(r.kcal), p: r1(r.p), f: r1(r.f), c: r1(r.c) },
    createdAt: now, updatedAt: now, deletedAt: null });
}

// вес: мердж по дате с бэкапом
const weightLogs = backup?.weightLogs ? [...backup.weightLogs] : [];
let weightsAdded = 0;
const wDates = new Set(weightLogs.filter(w => !w.deletedAt).map(w => w.date));
for (const { date, kg } of weights) {
  if (wDates.has(date)) continue;
  weightLogs.push({ id: uuid(), userId: 'local', date, weightKg: kg, source: 'mfp',
    createdAt: now, updatedAt: now, deletedAt: null });
  weightsAdded++;
}

// профиль: текущий вес = последнее известное значение
const profiles = backup?.profiles ? [...backup.profiles] : [];
if (profiles.length && weights.length) {
  const last = weights[weights.length - 1];
  profiles[0] = { ...profiles[0], weightKg: last.kg };
}

const dump = {
  app: 'deep-dish', version: 1, exportedAt: new Date().toISOString(),
  foods, recipes: backup?.recipes ?? [], savedMeals: backup?.savedMeals ?? [],
  slots: backup?.slots ?? [],
  entries: backup ? [...finalBackupEntries, ...importedEntries] : importedEntries,
  weightLogs, profiles,
};

const sum = k => Math.round(rows.reduce((s, r) => s + r[k], 0));
const out = outFile ?? `deepdish-mfp-${from}.json`;
writeFileSync(out, JSON.stringify(dump, null, 1), 'utf-8');
console.log(`Формат: ${detailed ? 'детальный (блюда)' : 'агрегатный (итоги приёмов)'}; ${rows.length} приёмов за ${from}..${to} (${new Set(rows.map(r => r.date)).size} дней)${until ? ` — обрезано до ${until} включительно` : ''}`);
console.log(`Суммарно: ${sum('kcal')} ккал · Б ${sum('p')} г · Ж ${sum('f')} г · У ${sum('c')} г; продуктов: ${madeFoods} новых${detailed ? `, ${reused} совпало` : ''}; вес: +${weightsAdded} записей${weights.length ? ` (последний ${weights[weights.length - 1].kg} кг)` : ''}${backup ? `; тестовых записей DD за диапазон помечено удалёнными: ${replaced.size}` : ' (бэкап не задан — только добавление)'}`);
console.log(`Файл: ${out} — залить в приложении: Настройки → Данные → Импорт JSON`);
