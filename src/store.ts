// Слой доступа к данным + расчёты нормы + трекер метрик
import { bannerAction } from './banner';
import { db, newId, LOCAL_USER, type Entry, type Food, type Profile, type Recipe, type Slot, type KbjuSnapshot, type DayNorma } from './db';
import { todayISO, nowHM, kbjuSuspicious, fmt, normE } from './lib';

// ── Метрики ──
const SESSION = newId();
export function track(name: string, props: Record<string, unknown> = {}) {
  db.events.add({ id: newId(), ts: Date.now(), session: SESSION, name, props: JSON.stringify({ v: __APP_VER__, ...props }) }).catch(() => {});
}

// ── Слоты ──
export async function getSlots(): Promise<Slot[]> {
  const s = await db.slots.filter(x => !x.deletedAt).toArray();
  return s.sort((a, b) => a.sortOrder - b.sortOrder);
}

// ── Записи ──
export async function getEntries(date: string): Promise<Entry[]> {
  return db.entries.where('[userId+date]').equals([LOCAL_USER, date]).filter(e => !e.deletedAt).toArray();
}

export async function saveEntry(e: Entry) {
  const now = Date.now();
  await db.entries.put({ ...e, updatedAt: now });
}

export async function addEntry(params: {
  date: string; slot: Slot; kind: 'food' | 'recipe'; refId: string; grams: number;
  per100: KbjuSnapshot; timeEaten?: string;
}): Promise<Entry> {
  const k = params.grams / 100; // для порционных grams = шт × 100 (условные)
  const entry: Entry = {
    id: newId(), userId: LOCAL_USER, date: params.date,
    timeEaten: params.timeEaten ?? params.slot.defaultTime ?? nowHM(),
    slotId: params.slot.id, kind: params.kind, refId: params.refId, grams: params.grams,
    snapshot: {
      kcal: Math.round(params.per100.kcal * k),
      p: Math.round(params.per100.p * k * 10) / 10,
      f: Math.round(params.per100.f * k * 10) / 10,
      c: Math.round(params.per100.c * k * 10) / 10,
    },
    createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
  };
  await db.entries.add(entry);
  bannerAction();
  return entry;
}

export async function deleteEntry(id: string) {
  await db.entries.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
}

// ── Продукты/рецепты ──
export type CatalogItem =
  | { kind: 'food'; id: string; name: string; sub: string; star: boolean; suspicious: boolean; per100: KbjuSnapshot; unit: 'g' | 'pc'; food: Food }
  | { kind: 'recipe'; id: string; name: string; sub: string; star: boolean; suspicious: boolean; per100: KbjuSnapshot; unit: 'g'; recipe: Recipe };

export async function getCatalog(query: string): Promise<CatalogItem[]> {
  const q = query.trim().toLowerCase();
  const isBarcode = /^\d{8,13}$/.test(q);
  const foods = (await db.foods.filter(f => !f.deletedAt && !f.hidden).toArray()).filter(f =>
    !q || normE(f.name).includes(normE(q)) || normE(f.brand ?? '').includes(normE(q))
    || (isBarcode && (f.barcode ?? '').includes(q)));
  const recipes = (await db.recipes.filter(r => !r.deletedAt).toArray()).filter(r =>
    !q || r.name.toLowerCase().includes(q));
  const items: CatalogItem[] = [
    ...foods.map<CatalogItem>(f => ({
      kind: 'food', id: f.id, name: f.name,
      sub: f.source === 'system' ? f.category : f.brand ? `${f.brand} · свой` : (f.unit === 'pc' ? 'свой · порционный' : 'свой продукт'),
      star: !!f.star, unit: f.unit === 'pc' ? 'pc' : 'g',
      suspicious: kbjuSuspicious(f.kcalPer100g, f.pPer100g, f.fPer100g, f.cPer100g, f.name),
      per100: { kcal: f.kcalPer100g, p: f.pPer100g, f: f.fPer100g, c: f.cPer100g },
      food: f,
    })),
    ...recipes.map<CatalogItem>(r => ({
      kind: 'recipe', id: r.id, name: r.name, sub: 'рецепт', star: !!r.star, unit: 'g',
      suspicious: false,
      per100: { kcal: r.kcalPer100g, p: r.pPer100g, f: r.fPer100g, c: r.cPer100g },
      recipe: r,
    })),
  ];
  return items;
}

/** Недавние: последние уникальные позиции из дневника (по kind+refId). */
export async function getRecent(limit = 12): Promise<Array<{ kind: 'food' | 'recipe'; refId: string }>> {
  const since = Date.now() - 60 * 86400000; // недавние = за последние 60 дней (В., 09.10)
  const es = await db.entries.orderBy('createdAt').reverse().filter(e => !e.deletedAt && e.createdAt >= since).limit(400).toArray();
  const seen = new Set<string>(); const out: Array<{ kind: 'food' | 'recipe'; refId: string }> = [];
  for (const e of es) {
    const key = `${e.kind}:${e.refId}`;
    if (!seen.has(key)) { seen.add(key); out.push({ kind: e.kind, refId: e.refId }); if (out.length >= limit) break; }
  }
  return out;
}

/** Последняя порция позиции (для предзаполнения при повторе). */
export async function lastGrams(kind: 'food' | 'recipe', refId: string): Promise<number | undefined> {
  const es = await db.entries.orderBy('createdAt').reverse()
    .filter(e => !e.deletedAt && e.kind === kind && e.refId === refId).limit(1).toArray();
  return es[0]?.grams;
}

export async function toggleStar(item: CatalogItem) {
  if (item.kind === 'food') await db.foods.update(item.id, { star: !item.star, updatedAt: Date.now() });
  else await db.recipes.update(item.id, { star: !item.star, updatedAt: Date.now() });
}

export async function getFood(id: string): Promise<Food | undefined> { return db.foods.get(id); }
export async function getRecipe(id: string): Promise<Recipe | undefined> { return db.recipes.get(id); }

export async function saveCustomFood(f: Omit<Food, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'ownerId' | 'source' | 'isPublic'>): Promise<Food> {
  const food: Food = { ...f, id: newId(), source: 'custom', ownerId: LOCAL_USER, isPublic: true, star: false, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null };
  await db.foods.add(food);
  track('food_created', { suspicious: kbjuSuspicious(food.kcalPer100g, food.pPer100g, food.fPer100g, food.cPer100g, food.name) });
  return food;
}

export async function saveRecipe(name: string, items: Array<{ foodId: string; grams: number }>, yieldG: number): Promise<Recipe> {
  const foods = await Promise.all(items.map(i => db.foods.get(i.foodId)));
  let kcal = 0, p = 0, f = 0, c = 0;
  items.forEach((it, i) => {
    const fd = foods[i];
    if (!fd) return;
    const k = it.grams / 100;
    kcal += fd.kcalPer100g * k; p += fd.pPer100g * k; f += fd.fPer100g * k; c += fd.cPer100g * k;
  });
  const y = Math.max(yieldG, 1);
  const recipe: Recipe = {
    id: newId(), name, items, yieldG: y,
    kcalPer100g: Math.round(kcal / y * 100) / 100,
    pPer100g: Math.round(p / y * 1000) / 10,
    fPer100g: Math.round(f / y * 1000) / 10,
    cPer100g: Math.round(c / y * 1000) / 10,
    ownerId: LOCAL_USER, isPublic: true, star: false,
    createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
  };
  await db.recipes.add(recipe);
  track('recipe_created', { items: items.length });
  return recipe;
}

// ── Профиль и норма ──
export async function getProfile(): Promise<Profile | undefined> { return db.profiles.get(LOCAL_USER); }
export async function saveProfile(p: Profile) {
  const prev = await getProfile();
  await db.profiles.put({ ...p, userId: LOCAL_USER, updatedAt: Date.now() });
  // изменение веса в профиле = взвешивание (ручной ввод до Health-моста, M3)
  if (p.weightKg !== undefined && p.weightKg > 0 && prev?.weightKg !== p.weightKg) {
    const today = todayISO();
    const exist = await db.weightLogs.where('[userId+date]').equals([LOCAL_USER, today]).first();
    if (exist && !exist.deletedAt) await db.weightLogs.update(exist.id, { weightKg: p.weightKg, updatedAt: Date.now() });
    else await db.weightLogs.add({ id: newId(), userId: LOCAL_USER, date: today, weightKg: p.weightKg, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null });
    track('weight_logged', { kg: p.weightKg, source: 'profile' });
  }
}

const ACT: Record<Profile['activity'], number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };

export interface Norma { kcal: number; p: number; f: number; c: number; bmr: number; tdee: number; adj: number; }

export function calcNorma(pr: Profile): Norma | null {
  const weight = pr.weightKg ?? (pr.goalWeightKg && pr.goal === 'maintain' ? pr.goalWeightKg : undefined);
  if (weight === undefined && !(pr.formula === 'manual' && pr.manualTdee)) return null; // нет точки отсчёта
  let tdee: number; let bmr: number;
  if (pr.formula === 'manual' && pr.manualTdee) {
    tdee = pr.manualTdee;
    bmr = Math.round(tdee / ACT[pr.activity]);
  } else {
    bmr = Math.round(10 * weight! + 6.25 * pr.heightCm - 5 * pr.age + (pr.gender === 'male' ? 5 : -161));
    tdee = bmr * ACT[pr.activity];
  }
  let adj = 0;
  if (pr.goal === 'lose') adj = -Math.min(Math.round(pr.paceKgPerWeek * 7700 / 7), 750);
  if (pr.goal === 'gain') adj = Math.min(Math.round(pr.paceKgPerWeek * 7700 / 7), 500);
  let kcal = tdee + adj;
  kcal = Math.max(Math.round(kcal / 10) * 10, Math.round(bmr * 1.1));
  const pct = pr.macroPct ?? { p: 25, f: 30, c: 45 };
  return {
    kcal, p: Math.round(kcal * pct.p / 100 / 4), f: Math.round(kcal * pct.f / 100 / 9),
    c: Math.round(kcal * pct.c / 100 / 4), bmr, tdee: Math.round(tdee), adj,
  };
}

// ── M1: вес, адаптивная норма по энергобалансу, снапшоты дня ──────────────────

export interface WeightPoint { date: string; kg: number }

export async function getWeights(): Promise<WeightPoint[]> {
  const ws = await db.weightLogs.filter(w => !w.deletedAt && w.userId === LOCAL_USER).toArray();
  return ws.map(w => ({ date: w.date, kg: w.weightKg })).sort((a, b) => a.date < b.date ? -1 : 1);
}

/** сумма ккал по дням за диапазон [from, to] включительно */
export async function getDailyIntake(from: string, to: string): Promise<Map<string, number>> {
  const es = await db.entries.filter(e => !e.deletedAt && e.date >= from && e.date <= to).toArray();
  const m = new Map<string, number>();
  for (const e of es) m.set(e.date, (m.get(e.date) ?? 0) + e.snapshot.kcal);
  return m;
}

/** линейная регрессия веса: slope кг/день */
export function weightTrend(points: WeightPoint[]): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const t0 = new Date(points[0].date).getTime();
  const xs = points.map(p => (new Date(p.date).getTime() - t0) / 86400000);
  const ys = points.map(p => p.kg);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

function weightAt(points: WeightPoint[], date: string): number | null {
  let best: WeightPoint | null = null; let bd = Infinity;
  const t = new Date(date).getTime();
  for (const p of points) {
    const d = Math.abs(new Date(p.date).getTime() - t);
    if (d < bd) { bd = d; best = p; }
  }
  return best?.kg ?? null;
}

export interface AdaptiveInfo {
  tdee: number; windowDays: number; coverage: number; intakeAvg: number; weightDelta: number; from: string; to: string;
}

/** фактический расход из истории: окна по 28 дней за последние 120, покрытие ≥75% */
export function adaptiveTdee(weights: WeightPoint[], intake: Map<string, number>, endDate: string): AdaptiveInfo | null {
  if (weights.length < 2) return null;
  const end = new Date(endDate + 'T00:00:00');
  const windows: AdaptiveInfo[] = [];
  for (let off = 0; off <= 92; off += 7) {
    const e = new Date(end); e.setDate(e.getDate() - off);
    const b = new Date(e); b.setDate(b.getDate() - 27);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(b), to = iso(e);
    let days = 0, sum = 0;
    for (let d = new Date(b); d <= e; d.setDate(d.getDate() + 1)) {
      const k = intake.get(iso(d)) ?? 0;
      if (k > 0) { days++; sum += k; }
    }
    if (days < 21) continue; // неплотное окно пропускаем
    const wa = weightAt(weights, from), wb = weightAt(weights, to);
    if (wa === null || wb === null) continue;
    const delta = wb - wa;
    const tdee = (sum - delta * 7700) / 28;
    if (tdee < 1200 || tdee > 5000) continue; // защита от мусорных окон
    windows.push({ tdee, windowDays: 28, coverage: days / 28, intakeAvg: sum / 28, weightDelta: delta, from, to });
  }
  if (!windows.length) return null;
  return windows[0]; // первое = самое свежее (off растёт в прошлое)
}

/** снапшот нормы за день: фиксируется при первом просмотре, прошлое не пересчитывается */
export async function ensureDayNorma(date: string): Promise<DayNorma | null> {
  const pr = await getProfile();
  if (!pr) return null;
  const existing = await db.dayNormas.get(date);
  if (existing) return existing;
  const base = calcNorma(pr);
  if (!base) return null;
  const today = todayISO();
  const weights = await getWeights();
  const upTo = weights.length ? weights[weights.length - 1].date : today;
  const from = new Date(new Date(upTo + 'T00:00:00').getTime() - 119 * 86400000).toISOString().slice(0, 10);
  const intake = await getDailyIntake(from, upTo);
  const ad = adaptiveTdee(weights, intake, upTo);
  let kcal = base.kcal;
  const detail: DayNorma['detail'] = { bmr: base.bmr, tdeeFormula: base.tdee, adj: base.adj };
  if (ad && ad.coverage >= 0.75) {
    // мягкая подстройка: не дальше ±350 ккал от формулы, не ниже пола 1.1×BMR
    const shifted = Math.round(base.tdee + Math.max(-350, Math.min(350, ad.tdee - base.tdee)));
    let k = shifted + base.adj;
    k = Math.max(Math.round(k / 10) * 10, Math.round(base.bmr * 1.1));
    kcal = k;
    detail.tdeeAdaptive = Math.round(ad.tdee);
    detail.windowDays = ad.windowDays; detail.coverage = Math.round(ad.coverage * 100);
    detail.intakeAvg = Math.round(ad.intakeAvg); detail.weightDelta = Math.round(ad.weightDelta * 10) / 10;
  }
  const snap: DayNorma = {
    date, kcal, p: Math.round(kcal * (pr.macroPct?.p ?? 25) / 100 / 4),
    f: Math.round(kcal * (pr.macroPct?.f ?? 30) / 100 / 9), c: Math.round(kcal * (pr.macroPct?.c ?? 45) / 100 / 4),
    basis: detail.tdeeAdaptive ? 'adaptive' : 'formula', detail, createdAt: Date.now(),
  };
  if (date <= today) await db.dayNormas.put(snap); // будущее не фиксируем
  return snap;
}

/**
 * Прогресс к цели (формула В.): целевая разница D0 = текущий − цель;
 * прогнозный вес к целевой дате по тренду → прогнозная разница D1 = текущий − прогноз (min 0);
 * выполнение = D1 / D0. Целевая дата фиксируется в профиле (дефолт — от темпа).
 */
export interface GoalProgress {
  pct: number; startKg: number; goalKg: number; goalDate: string;
  forecastKg: number; slopePerWeek: number; trendWindowDays: number;
  /** true — дата уже зафиксирована в профиле; false — компонент должен сохранить дефолт (вне liveQuery) */
  dateFixed: boolean;
}

export async function goalProgress(): Promise<GoalProgress | null> {
  const pr = await getProfile();
  if (!pr?.goalWeightKg || pr.goal === 'none' || pr.goal === 'maintain') return null;
  const weights = await getWeights();
  if (weights.length < 2) return null;
  const cur = weights[weights.length - 1].kg;
  const last = weights[weights.length - 1].date;
  const trendDays = 56;
  const from = new Date(new Date(last + 'T00:00:00').getTime() - (trendDays - 1) * 86400000).toISOString().slice(0, 10);
  const win = weights.filter(w => w.date >= from);
  const tr = weightTrend(win);
  if (!tr) return null;
  // целевая дата — всегда от текущего темпа из профиля (В., 09.10: меняешь темп — меняется дата и прогнозы)
  const pace = pr.paceKgPerWeek || 0.5;
  const weeks = Math.max(1, Math.round(Math.abs(cur - pr.goalWeightKg) / pace));
  const gd = new Date(); gd.setDate(gd.getDate() + weeks * 7);
  const goalDate = gd.toISOString().slice(0, 10);
  const dateFixed = true;
  const t0 = new Date(win[0].date).getTime();
  const etaX = (new Date(goalDate + 'T00:00:00').getTime() - t0) / 86400000;
  const forecastKg = tr.slope * etaX + tr.intercept;
  const d0 = Math.max(0.001, cur - pr.goalWeightKg);
  const d1 = Math.max(0, cur - forecastKg);
  const pct = Math.max(0, Math.min(100, Math.round(d1 / d0 * 100)));
  return { pct, startKg: cur, goalKg: pr.goalWeightKg, goalDate, dateFixed,
    forecastKg: Math.round(forecastKg * 10) / 10, slopePerWeek: Math.round(-tr.slope * 700) / 100, trendWindowDays: trendDays };
}

/** прогноз даты достижения цели по тренду (для профиля) */
export async function weightForecast(): Promise<{ slopePerWeek: number; etaDate: string; trendKg: number } | null> {
  const g = await goalProgress();
  if (!g || g.slopePerWeek <= 0) return null;
  return { slopePerWeek: g.slopePerWeek, etaDate: g.goalDate, trendKg: g.forecastKg };
}

// ── Экспорт ──
export async function exportJSON(): Promise<Blob> {
  const dump = {
    app: 'deep-dish', version: 1, exportedAt: new Date().toISOString(),
    foods: await db.foods.toArray(), recipes: await db.recipes.toArray(),
    savedMeals: await db.savedMeals.toArray(), slots: await db.slots.toArray(),
    entries: await db.entries.toArray(), weightLogs: await db.weightLogs.toArray(),
    dayNormas: await db.dayNormas.toArray(),
    profiles: await db.profiles.toArray(),
  };
  return new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
}

export async function exportCSV(): Promise<Blob> {
  const slots = await getSlots();
  const slotName = new Map(slots.map(s => [s.id, s.name]));
  const foods = await db.foods.toArray(); const recipes = await db.recipes.toArray();
  const nm = (e: Entry) =>
    e.kind === 'food' ? (foods.find(f => f.id === e.refId)?.name ?? e.refId)
      : (recipes.find(r => r.id === e.refId)?.name ?? e.refId);
  const es = (await db.entries.filter(e => !e.deletedAt).toArray()).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.timeEaten < b.timeEaten ? -1 : 1);
  const rows = [['дата', 'время', 'приём', 'блюдо', 'граммы', 'ккал', 'белки', 'жиры', 'углеводы'].join(';')];
  for (const e of es) rows.push([e.date, e.timeEaten, slotName.get(e.slotId) ?? '', nm(e), String(e.grams), String(e.snapshot.kcal), String(e.snapshot.p), String(e.snapshot.f), String(e.snapshot.c)].join(';'));
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
  await db.transaction('rw', [db.foods, db.recipes, db.savedMeals, db.slots, db.entries, db.weightLogs, db.profiles], async () => {
    await Promise.all([db.foods.clear(), db.recipes.clear(), db.savedMeals.clear(), db.slots.clear(), db.entries.clear(), db.weightLogs.clear(), db.profiles.clear()]);
  });
  track('wipe_all');
}

// ── Сохранённые приёмы («мой завтрак» одним тапом) ────────────────────────────

export async function saveMealFromSlot(name: string, slotId: string, date: string): Promise<number> {
  const es = (await db.entries.where('date').equals(date).toArray())
    .filter(e => e.slotId === slotId && !e.deletedAt && e.kind === 'food');
  if (!es.length) return 0;
  await db.savedMeals.add({
    id: newId(), name, items: es.map(e => ({ foodId: e.refId, grams: e.grams })),
    slotHint: slotId, ownerId: LOCAL_USER, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
  });
  track('meal_saved', { items: es.length });
  return es.length;
}

export async function applyMeal(mealId: string, date: string, slot: Slot): Promise<number> {
  const meal = await db.savedMeals.get(mealId);
  if (!meal || meal.deletedAt) return 0;
  let n = 0;
  for (const it of meal.items) {
    const f = await db.foods.get(it.foodId);
    if (!f || f.deletedAt) continue;
    await addEntry({ date, slot, kind: 'food', refId: it.foodId, grams: it.grams,
      per100: { kcal: f.kcalPer100g, p: f.pPer100g, f: f.fPer100g, c: f.cPer100g } });
    n++;
  }
  if (n) track('meal_applied', { items: n });
  return n;
}

export async function deleteMeal(id: string) {
  await db.savedMeals.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
}

// ── Импорт JSON (восстановление бэкапа) ───────────────────────────────────────

export async function importJSONText(text: string): Promise<Record<string, number>> {
  const d = JSON.parse(text) as Record<string, unknown>;
  if (d?.app !== 'deep-dish') throw new Error('это не бэкап Deep Dish');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tabs: Array<[any, string]> = [
    [db.foods, 'foods'], [db.recipes, 'recipes'], [db.savedMeals, 'savedMeals'],
    [db.slots, 'slots'], [db.entries, 'entries'], [db.weightLogs, 'weightLogs'], [db.profiles, 'profiles'],
  ];
  const counts: Record<string, number> = {};
  for (const [t, k] of tabs) {
    const arr = d[k];
    if (!Array.isArray(arr) || !arr.length) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (t as any).bulkPut(arr);
    counts[k] = arr.length;
  }
  track('import_json', counts);
  return counts;
}

export const TODAY = () => todayISO();
export { fmt };
