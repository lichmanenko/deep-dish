// Мотивационные баннеры (M1): «так держать» утром + «окно срыва» с упреждением.
// Состояние и флаги — localStorage (per-device); расчёт — из истории записей.
import { db } from './db';
import { todayISO } from './lib';
import { goalProgress } from './store';
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
    // А1(ревью): MFP-эру не берём — скрытые продукты и timeApprox (фиктивное время слота)
    if (!f || f.hidden || e.timeApprox || !cats.includes(f.category)) continue;
    const h = parseInt(e.timeEaten.slice(0, 2), 10);
    if (Number.isFinite(h)) out.push({ date: e.date, hour: h });
  }
  return out;
}

/**
 * Часовые окна, где флаг-еда встречалась ≥3 раз за 60 дней минимум в 3 РАЗНЫХ днях.
 * Порог «разных дней» (В., 22.10): у новой истории (пара дней ведения) случайные
 * повторы вроде «кофе после обеда» не должны сразу объявляться слабым временем.
 */
/** Окна срыва: час × ≥3 событий из ≥3 РАЗНЫХ дней (В., 24.10: 3 события одного-двух дней — не тренд). */
export function windowsFromEntries(es: Array<{ date: string; hour: number }>): Array<{ hour: number; count: number }> {
  const byHour = new Map<number, { count: number; days: Set<string> }>();
  for (const e of es) {
    const cur = byHour.get(e.hour) ?? { count: 0, days: new Set<string>() };
    cur.count++; cur.days.add(e.date);
    byHour.set(e.hour, cur);
  }
  return [...byHour.entries()]
    .filter(([, v]) => v.count >= 3 && v.days.size >= 3)
    .map(([hour, v]) => ({ hour, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

export async function detectDangerWindows(): Promise<Array<{ hour: number; count: number }>> {
  const flags = loadFlags();
  const es = await flagEntries(flags.cats);
  return windowsFromEntries(es);
}

const PRAISE_BOLD = [
  () => 'Так держать! 🔥 План по темпу выполняется — ты в игре.',
  () => 'Тренд не врёт: ты не медленнее плана 💪 Так и держи.',
  () => 'Дисциплина уровня «профи» 🏆 темп ровный, план идёт.',
];
const PRAISE_CALM = [
  () => 'Так держать — план по темпу выполняется ✅',
  () => 'Хороший ровный темп 🙂 продолжай в том же ритме.',
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

  // «так держать»: утро, тренд совпадает с целью и не медленнее плана
  if (flags.praise && !st.praiseDone && hh < 12) {
    const gp = await goalProgress();
    if (gp && gp.pct >= 100) {
      const bold = hashIdx(todayISO() + 'p', 5) < 3;
      const arr = bold ? PRAISE_BOLD : PRAISE_CALM;
      st.praiseDone = true; saveBannerState(st);
      return { kind: 'praise', text: arr[hashIdx(todayISO(), arr.length)]() };
    }
  }
  // А3(ревью): «держать» — похвала за стабильность (тренд в пределах ±0,1 кг/нед, данные есть)
  if (flags.praise && !st.praiseDone && hh < 12) {
    const pr = await db.profiles.get('local');
    if (pr?.goal === 'maintain') {
      const weights = (await db.weightLogs.filter(w => !w.deletedAt).toArray())
        .map(w => ({ date: w.date, kg: w.weightKg })).sort((a, b) => a.date < b.date ? -1 : 1);
      const from = new Date(Date.now() - 55 * 86400000);
      const p2 = (n: number) => String(n).padStart(2, '0');
      const fromIso = `${from.getFullYear()}-${p2(from.getMonth() + 1)}-${p2(from.getDate())}`;
      const win = weights.filter(w => w.date >= fromIso);
      if (win.length >= 4) {
        const t0 = new Date(win[0].date + 'T00:00:00').getTime();
        const xs = win.map(w => (new Date(w.date + 'T00:00:00').getTime() - t0) / 86400000);
        const ys = win.map(w => w.kg);
        const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
        const pw = den ? Math.abs(num / den) * 7 : 99;
        if (pw <= 0.1) {
          const arr = hashIdx(todayISO() + 'p', 5) < 3 ? PRAISE_BOLD : PRAISE_CALM;
          st.praiseDone = true; saveBannerState(st);
          return { kind: 'praise', text: arr[hashIdx(todayISO(), arr.length)]() };
        }
      }
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
