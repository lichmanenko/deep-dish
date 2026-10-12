import Dexie, { type EntityTable } from 'dexie';
import productsSeed from '../data/products_v2.json';

// ── Типы данных (SPEC §3) ──────────────────────────────────────────────────────

export type FoodSource = 'system' | 'custom' | 'off' | 'fork' | 'mfp';

export interface Food {
  id: string; name: string; brand?: string; category: string;
  kcalPer100g: number; pPer100g: number; fPer100g: number; cPer100g: number;
  /** 'pc' — порционный продукт: КБЖУ указаны НА 1 ПОРЦИЮ (в per100-полях), ввод в штуках (дробно) */
  unit?: 'g' | 'pc';
  portionG?: number; portionLabel?: string; barcode?: string;
  source: FoodSource; ownerId: string; isPublic: boolean; star?: boolean;
  /** служебный продукт (импорт MFP): в каталоге и поиске не показывается, записи отображаются */
  hidden?: boolean;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

export interface RecipeItem { foodId: string; grams: number; }

export interface Recipe {
  id: string; name: string; items: RecipeItem[]; yieldG: number;
  kcalPer100g: number; pPer100g: number; fPer100g: number; cPer100g: number;
  ownerId: string; isPublic: boolean; star?: boolean;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

export interface SavedMeal {
  id: string; name: string; items: RecipeItem[]; slotHint?: string; ownerId: string;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

export interface Slot {
  id: string; name: string; emoji?: string; sortOrder: number; isDefault: boolean;
  /** автоподстановка времени при вводе; null = «сейчас» (перекус) */
  defaultTime: string | null;
  ownerId: string; createdAt: number; updatedAt: number; deletedAt: number | null;
}

export interface KbjuSnapshot { kcal: number; p: number; f: number; c: number; }

export interface Entry {
  id: string; userId: string;
  date: string;            // YYYY-MM-DD, локальная
  timeEaten: string;       // HH:MM — у каждой записи своё
  /** true — время фиктивное (импорт MFP: слот, не факт) — детектор окон срыва не учитывает */
  timeApprox?: boolean;
  slotId: string;
  kind: 'food' | 'recipe'; refId: string; grams: number;
  snapshot: KbjuSnapshot;  // ккал/Б/Ж/У порции на момент ввода
  note?: string;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

export interface WeightLog {
  id: string; userId: string; date: string; weightKg: number; bodyFatPct?: number;
  source: 'manual' | 'health' | 'mfp';
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

/** Пометка «приём не учтён» (праздник и т.п.): день с помеченным приёмом
 * выбраковывается из расчёта адаптивной нормы (частично известный день не годится). */
export interface SlotMark {
  id: string; // date + '|' + slotId
  date: string; slotId: string; untracked: boolean;
  userId: string; createdAt: number; updatedAt: number; deletedAt: number | null;
}

/** Снапшот дневной нормы: фиксируется за днём, прошлое не пересчитывается (решение В.). */
export interface DayNorma {
  date: string; // YYYY-MM-DD, первичный ключ
  /** true — снапшот создан задним числом (день впервые открыт позже) */
  retro?: boolean;
  kcal: number; p: number; f: number; c: number;
  basis: 'formula' | 'adaptive';
  /** компоненты для экрана «почему такая цифра» */
  detail: { bmr?: number; tdeeFormula?: number; tdeeAdaptive?: number; adj?: number; floor?: number;
    windowDays?: number; coverage?: number; intakeAvg?: number; weightDelta?: number;
    /** v0.5.0: прогресс цели-темпа за этот день (тренд/план, %) */
    goalPct?: number; trendPw?: number; planPw?: number };
  createdAt: number;
}

export interface Profile {
  userId: string;
  gender: 'male' | 'female'; age: number; heightCm: number;
  /** текущий вес — точка отсчёта нормы (M1: старт лога веса) */
  weightKg?: number;
  formula: 'mifflin' | 'manual'; manualTdee?: number;
  activity: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal: 'none' | 'lose' | 'maintain' | 'gain';
  paceKgPerWeek: number;
  goalWeightKg?: number;
  /** распределение макросов: режим пресета или 'custom' с ручными процентами */
  macroMode?: 'balanced' | 'mfp' | 'protein' | 'custom';
  /** целевая дата цели (YYYY-MM-DD); фиксируется автоматически от темпа, для кольца выполнения цели */
  goalDateIso?: string;
  /** v0.5.0: карточка пользователя — имя и аватар (dataURL, 128×128, сжатие на устройстве) */
  displayName?: string;
  avatar?: string;
  macroPct?: { p: number; f: number; c: number };
  updatedAt: number;
}

export interface MetricEvent {
  id: string; ts: number; session: string; name: string; props: string; // JSON
}

// ── Идентификаторы ────────────────────────────────────────────────────────────

/** UUIDv7: сортируем по времени, уникален без сервера. */
export function newId(): string {
  const t = Date.now();
  const rndB = crypto.getRandomValues(new Uint8Array(10));
  const b = new Uint8Array(16);
  b[0] = (t / 2 ** 40) & 255; b[1] = (t / 2 ** 32) & 255; b[2] = (t / 2 ** 24) & 255;
  b[3] = (t / 2 ** 16) & 255; b[4] = (t / 2 ** 8) & 255; b[5] = t & 255;
  b[6] = 0x70 | (rndB[0] & 0x0f); b[7] = rndB[1]; b[8] = 0x80 | (rndB[2] & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rndB[i - 6];
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/** Локальный юзер до появления сервера (M2 подменит на серверный id). */
export const LOCAL_USER = 'local';
const EPOCH = 1;

// ── База ──────────────────────────────────────────────────────────────────────

class DeepDishDb extends Dexie {
  foods!: EntityTable<Food, 'id'>;
  recipes!: EntityTable<Recipe, 'id'>;
  savedMeals!: EntityTable<SavedMeal, 'id'>;
  dayNormas!: EntityTable<DayNorma, 'date'>;
  slotMarks!: EntityTable<SlotMark, 'id'>;
  slots!: EntityTable<Slot, 'id'>;
  entries!: EntityTable<Entry, 'id'>;
  weightLogs!: EntityTable<WeightLog, 'id'>;
  profiles!: EntityTable<Profile, 'userId'>;
  events!: EntityTable<MetricEvent, 'id'>;

  constructor() {
    super('deepdish');
    // v1 — историческая (совместимость с уже созданными базами)
    this.version(1).stores({
      foods: 'id, name, category, barcode, ownerId, source, deletedAt',
      recipes: 'id, name, ownerId, deletedAt',
      savedMeals: 'id, name, ownerId, deletedAt',
      slots: 'id, ownerId, sortOrder, deletedAt',
      entries: 'id, userId, date, slotId, refId, deletedAt, [userId+date]',
      weightLogs: 'id, userId, date, deletedAt, [userId+date]',
      profiles: 'userId',
    });
    // v2 — звёзды, дефолтные времена слотов, таблица событий метрик
    this.version(2).stores({
      foods: 'id, name, category, barcode, ownerId, source, deletedAt, star',
      recipes: 'id, name, ownerId, deletedAt, star',
      savedMeals: 'id, name, ownerId, deletedAt',
      slots: 'id, ownerId, sortOrder, deletedAt',
      entries: 'id, userId, date, slotId, refId, deletedAt, [userId+date]',
      weightLogs: 'id, userId, date, deletedAt, [userId+date]',
      profiles: 'userId',
      events: 'id, ts, name',
    }).upgrade(async (tx) => {
      await tx.table('foods').toCollection().modify(f => { if (f.star === undefined) f.star = false; });
      await tx.table('recipes').toCollection().modify(r => { if (r.star === undefined) r.star = false; });
      await tx.table('slots').toCollection().modify((s: Slot) => {
        if (s.defaultTime === undefined) {
          s.defaultTime = s.id === 'slot-breakfast' ? '08:00'
            : s.id === 'slot-lunch' ? '13:00' : s.id === 'slot-dinner' ? '19:00' : null;
        }
      });
    });
    // v3 — индекс createdAt для «недавних» и последней порции (без него orderBy падает)
    this.version(3).stores({
      foods: 'id, name, category, barcode, ownerId, source, deletedAt, star',
      recipes: 'id, name, ownerId, deletedAt, star',
      savedMeals: 'id, name, ownerId, deletedAt',
      slots: 'id, ownerId, sortOrder, deletedAt',
      entries: 'id, userId, date, slotId, refId, createdAt, deletedAt, [userId+date]',
      weightLogs: 'id, userId, date, deletedAt, [userId+date]',
      profiles: 'userId',
      events: 'id, ts, name',
    });
    // v4 — снапшоты дневной нормы (M1: прошлое не пересчитывается)
    this.version(4).stores({
      foods: 'id, name, category, barcode, ownerId, source, deletedAt, star',
      recipes: 'id, name, ownerId, deletedAt, star',
      savedMeals: 'id, name, ownerId, deletedAt',
      slots: 'id, ownerId, sortOrder, deletedAt',
      entries: 'id, userId, date, slotId, refId, createdAt, deletedAt, [userId+date]',
      weightLogs: 'id, userId, date, deletedAt, [userId+date]',
      profiles: 'userId',
      events: 'id, ts, name',
      dayNormas: 'date',
    });
    // v5 — пометки «приём не учтён» (выбраковка дней из адаптивной нормы)
    this.version(5).stores({
      foods: 'id, name, category, barcode, ownerId, source, deletedAt, star',
      recipes: 'id, name, ownerId, deletedAt, star',
      savedMeals: 'id, name, ownerId, deletedAt',
      slots: 'id, ownerId, sortOrder, deletedAt',
      entries: 'id, userId, date, slotId, refId, createdAt, deletedAt, [userId+date]',
      weightLogs: 'id, userId, date, deletedAt, [userId+date]',
      profiles: 'userId',
      events: 'id, ts, name',
      dayNormas: 'date',
      slotMarks: 'id, date',
    });
  }
}

export const db = new DeepDishDb();

const DEFAULT_SLOTS: Array<Pick<Slot, 'id' | 'name' | 'emoji' | 'sortOrder' | 'defaultTime'>> = [
  { id: 'slot-breakfast', name: 'Завтрак', emoji: '🥐', sortOrder: 1, defaultTime: '08:00' },
  { id: 'slot-lunch', name: 'Обед', emoji: '🍲', sortOrder: 2, defaultTime: '13:00' },
  { id: 'slot-dinner', name: 'Ужин', emoji: '🌙', sortOrder: 3, defaultTime: '19:00' },
  { id: 'slot-snack', name: 'Перекус', emoji: '🍎', sortOrder: 4, defaultTime: null },
];

db.on('populate', (tx) => {
  const foods: Food[] = (productsSeed as Array<Record<string, unknown>>).map(p => ({
    id: String(p.id), name: String(p.name), category: String(p.category),
    kcalPer100g: Number(p.caloriesPer100g), pPer100g: Number(p.proteinPer100g),
    fPer100g: Number(p.fatPer100g), cPer100g: Number(p.carbsPer100g),
    source: 'system', ownerId: 'system', isPublic: true, star: false,
    createdAt: EPOCH, updatedAt: EPOCH, deletedAt: null,
  }));
  tx.table('foods').bulkAdd(foods);
  tx.table('slots').bulkAdd(DEFAULT_SLOTS.map(s => ({
    ...s, isDefault: true, ownerId: LOCAL_USER,
    createdAt: EPOCH, updatedAt: EPOCH, deletedAt: null,
  })));
});
