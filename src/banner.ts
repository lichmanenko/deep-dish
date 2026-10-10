// Мотивационные баннеры (M1): «так держать» утром + «окно срыва» с упреждением.
// Состояние и флаги — localStorage (per-device); расчёт — из истории записей.
import { db } from './db';
import { todayISO } from './lib';
import { weightForecast } from './store';
import type { Entry, Food } from './db';

export interface FlagSettings { praise: boolean; warn: boolean; cats: string[] }
const DEF_FLAGS: FlagSettings = { praise: true, warn: true, cats: ['Сладкое', 'Фастфуд', 'Снеки', 'Алкоголь'] };
/** базовые флаг-категории: показываются всегда, даже если в каталоге таких нет (алкоголь в каталоге живёт в «Напитках») */
export const BASE_FLAG_CATS = ['Сладкое', 'Фастфуд', 'Снеки', 'Алкоголь'];

export function loadFlags(): FlagSettings {
  try {
    const raw = localStorage.getItem('dd-flags');
    if (raw) return { ...DEF_FLAGS, ...JSON.parse(raw) };
  } catch { /* повреждённые — дефолт */ }
  return { ...DEF_FLAGS };
}
export function saveFlags(f: FlagSettings) { localStorage.setItem('dd-flags', JSON.stringify(f)); }

interface BannerState { date: string; praiseDone: boolean; warnDone: boolean; acts: number }
function loadBannerState(): BannerState {
  try {
    const raw = localStorage.getItem('dd-banner');
    if (raw) { const s = JSON.parse(raw); if (s.date === todayISO()) return s; }
  } catch { /* ignore */ }
  return { date: todayISO(), praiseDone: false, warnDone: false, acts: 0 };
}
function saveBannerState(s: BannerState) { localStorage.setItem('dd-banner', JSON.stringify(s)); }

/** любое действие пользователя (запись еды) приближает авто-скрытие баннера */
export function bannerAction() {
  const s = loadBannerState();
  s.acts += 1;
  if (s.acts >= 3) { s.praiseDone = s.praiseDone || true; s.warnDone = true; }
  saveBannerState(s);
}

/** дневные записи с флаг-категорией за последние 60 дней: [{date, hour}] */
async function flagEntries(cats: string[]): Promise<Array<{ date: string; hour: number }>> {
  if (!cats.length) return [];
  const from = new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10);
  const es = await db.entries.filter((e: Entry) => !e.deletedAt && e.date >= from).toArray();
  const foods = new Map<string, Food>((await db.foods.toArray()).map(f => [f.id, f]));
  const out: Array<{ date: string; hour: number }> = [];
  for (const e of es) {
    const f = foods.get(e.refId);
    if (!f || !cats.includes(f.category)) continue;
    const h = parseInt(e.timeEaten.slice(0, 2), 10);
    if (Number.isFinite(h)) out.push({ date: e.date, hour: h });
  }
  return out;
}

/** часовые окна, где флаг-еда встречалась ≥3 раз за 60 дней (по каждому часу) */
export async function detectDangerWindows(): Promise<Array<{ hour: number; count: number }>> {
  const flags = loadFlags();
  const es = await flagEntries(flags.cats);
  const byHour = new Map<number, number>();
  for (const e of es) byHour.set(e.hour, (byHour.get(e.hour) ?? 0) + 1);
  return [...byHour.entries()].filter(([, n]) => n >= 3).map(([hour, count]) => ({ hour, count })).sort((a, b) => b.count - a.count);
}

const PRAISE_BOLD = [
  (d: string) => `Так держать! 🔥 Такими темпами цель сама к тебе идёт — уже видно к ${d}.`,
  (d: string) => `Тренд не врёт: ты быстрее плана 💪 ${d} — и цель твоя.`,
  (d: string) => `Дисциплина уровня «профи» 🏆 держишь темп, прогноз — ${d}.`,
];
const PRAISE_CALM = [
  (d: string) => `Так держать — план выполняется ✅ прогноз: ${d}.`,
  (d: string) => `Хороший ровный темп 🙂 если продолжать — цель к ${d}.`,
];
const WARN_BOLD = [
  (h: number) => `${h}:00 — твоё «слабое» время по статистике. Докажи ей обратное 😎`,
  (h: number) => `Килограммы сами к тебе не придут, а лишнее в ${h}:00 — легко. Не сегодня 🛡`,
  (h: number) => `История говорит: около ${h}:00 ты обычно добавляешь лишнее. Пусть сегодня она ошибётся ⚔️`,
];
const WARN_CALM = [
  (h: number) => `Скоро обычно бывает лишнее (около ${h}:00) — спланируй заранее 🕐`,
  (h: number) => `Аккуратнее: в это время (${h}:00) чаще всего добавляется лишнее`,
];

const ruDate = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const hashIdx = (s: string, n: number) => {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
};

export interface BannerInfo { kind: 'praise' | 'warn'; text: string; }
export const BANNER_CHECK_MS = 5 * 60 * 1000;

/** каким баннером встретить пользователя прямо сейчас (null — никакого) */
export async function computeBanner(): Promise<BannerInfo | null> {
  const flags = loadFlags();
  const st = loadBannerState();
  const now = new Date();
  const hh = now.getHours();

  // «окно срыва»: активен с (час − 1) до (час + 1); показ раз в день
  if (flags.warn && !st.warnDone) {
    const wins = await detectDangerWindows();
    const hit = wins.find(w => hh >= w.hour - 1 && hh <= w.hour);
    if (hit) {
      const bold = hashIdx(todayISO() + 'w', 5) < 3;
      const arr = bold ? WARN_BOLD : WARN_CALM;
      st.warnDone = true; saveBannerState(st);
      return { kind: 'warn', text: arr[hashIdx(todayISO(), arr.length)](hit.hour) };
    }
  }

  // «так держать»: утро, тренд к цели и не медленнее плана
  if (flags.praise && !st.praiseDone && hh < 12) {
    const fc = await weightForecast();
    const pr = await db.profiles.get('local');
    if (fc && pr?.goal === 'lose' && fc.slopePerWeek >= (pr.paceKgPerWeek || 0.5) - 0.01) {
      const bold = hashIdx(todayISO() + 'p', 5) < 3;
      const arr = bold ? PRAISE_BOLD : PRAISE_CALM;
      st.praiseDone = true; saveBannerState(st);
      return { kind: 'praise', text: arr[hashIdx(todayISO(), arr.length)](ruDate(fc.etaDate)) };
    }
  }
  return null;
}

/** пользователь закрыл крестиком — сегодня больше не показываем */
export function dismissBanner(kind: 'praise' | 'warn') {
  const st = loadBannerState();
  if (kind === 'praise') st.praiseDone = true; else st.warnDone = true;
  saveBannerState(st);
}
