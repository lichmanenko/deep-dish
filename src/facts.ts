// Факты-мотиваторы (v0.7.6): редкие карточки «ты не такой, как все».
// Канон — docs/FACTS.md: две части (число рынка + «а ты…»), простой язык, без имён/годов,
// относительные величины, 2+ независимых источника, прочитанность, не чаще 1 в 3 дня.
import { track } from './store';

export interface Fact {
  id: string;
  emoji: string;
  text: string;        // уже с персональной рамкой
  src: string;         // ссылка на источник (кнопка «Источник →»)
  cls: 1 | 2 | 3 | 4 | 5; // класс приоритета: 1 веха-сегодня, 2 возврат, 3 стрик, 4 стаж, 5 хвост
  rarity: number;      // внутри класса: выше — реже/важнее
}

// Только подтверждённые (2+ источника) — статусы в FACTS.md
export const FACTS: Fact[] = [
  // класс 1: личная веха веса (считаемая у нас; показывается в день достижения)
  { id: 'w5', emoji: '🎉', cls: 1, rarity: 50, text: 'Минус 5% от стартового веса: врачи считают это первым серьёзным улучшением — давление, сахар, печень уже лучше.', src: 'https://diabetesresearchcenter.wustl.edu/in-obese-patients-5-percent-weight-loss-has-significant-health-benefits' },
  // класс 2: возврат после пропуска — окно одного дня
  { id: 'gap_return', emoji: '🛫', cls: 2, rarity: 30, text: 'Вернуться после пропуска — самое редкое поведение в трекерах. Ты только что это сделал.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13085986' },
  // класс 3: стрик-вехи (показываются в день вехи)
  { id: 'streak3', emoji: '🔥', cls: 3, rarity: 10, text: 'До третьего дня подряд с записями доходят меньше половины начавших. Ты — здесь.', src: 'https://media.market.us/diet-and-nutrition-apps-statistics' },
  { id: 'streak7', emoji: '🌱', cls: 3, rarity: 20, text: 'Неделя непрерывных записей: дальше добровольно не идут 85 из 100 человек.', src: 'https://macrite.app/blog/why-80-percent-quit-calorie-tracking' },
  { id: 'streak30', emoji: '🌊', cls: 3, rarity: 40, text: 'Месяц подряд — уже редкость. Так начинают только самые упорные.', src: 'https://macrite.app/blog/why-80-percent-quit-calorie-tracking' },
  // класс 4: стаж-вехи
  { id: 'day30', emoji: '🗓', cls: 4, rarity: 30, text: 'Полгода ведут лишь 3 из 100. У тебя первый месяц за спиной.', src: 'https://macrite.app/blog/why-80-percent-quit-calorie-tracking' },
  { id: 'day50', emoji: '🧠', cls: 4, rarity: 35, text: 'Привычка закрепляется в среднем за 66 дней — ты на пороге автоматизма.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3505409' },
  { id: 'day100', emoji: '💯', cls: 4, rarity: 60, text: '7 из 10 бросают в первые 100 дней. Ты их прошёл.', src: 'https://media.market.us/diet-and-nutrition-apps-statistics' },
  { id: 'day180', emoji: '🏔', cls: 4, rarity: 80, text: 'Полгода с дневником — это топ-3% всех, кто когда-либо начинал.', src: 'https://macrite.app/blog/why-80-percent-quit-calorie-tracking' },
  { id: 'day365', emoji: '🎯', cls: 4, rarity: 100, text: 'Год учёта — редкость, на которую не способны даже платные подписчики.', src: 'https://nutrola.app/en/blog/how-long-users-stick-with-calorie-tracking-by-app-retention-data' },
  // класс 5: механика веса и тела (хвост, не чаще 1/9 дней)
  { id: 'precision', emoji: '🧮', cls: 5, rarity: 5, text: 'Даже неточный дневник добавляет в среднем −3 кг: работает осознанность, а не калькулятор.', src: 'https://fitchef.com/studies/calorie-tracking-weight-loss-study' },
  { id: 'moment_eat', emoji: '⚡', cls: 5, rarity: 4, text: 'Записавшие каждый приём теряют примерно вдвое больше — дневник важнее диеты.', src: 'https://www.levels.com/blog/can-meal-tracking-help-you-lose-weight' },
  { id: 'water', emoji: '🌊', cls: 5, rarity: 3, text: 'Вес скачет на 1–2 кг за день — это вода от соли и углеводов, не жир.', src: 'https://www.healthline.com/health/weight-fluctuation' },
  { id: 'weekend', emoji: '📅', cls: 5, rarity: 4, text: 'Вес почти у всех максимален в понедельник и падает к пятнице — сравнивай недели, не дни.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5644907' },
  { id: 'weigh', emoji: '⚖️', cls: 5, rarity: 3, text: 'Кто взвешивается регулярно, удерживает вес лучше — это подтверждают 11 из 12 исследований.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2588640' },
  { id: 'sleep', emoji: '😴', cls: 5, rarity: 3, text: 'Сон меньше 6 часов поднимает риск набора веса примерно на треть — вес начинается не на кухне.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2723045' },
  { id: 'slow', emoji: '🐢', cls: 5, rarity: 3, text: 'Медленная еда экономит до 10–15% калорий приёма: сигнал сытости опаздывает минут на двадцать.', src: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7746965' },
  { id: 'weekend_loss', emoji: '📉', cls: 5, rarity: 4, text: 'Набор выходных растворяется к пятнице, если не бросать учёт — «тяжёлый понедельник» лечится неделей.', src: 'https://news.cornell.edu/stories/2014/03/fat-tuesday-comes-once-year-heavy-monday-weekly' },
  { id: 'plateau', emoji: '🏜', cls: 5, rarity: 4, text: 'Плато в несколько недель — нормальная физиология: тело пересчитывает расход и притормаживает. Это не провал.', src: 'https://www.ncbi.nlm.nih.gov/books/NBK576400' },
];

// ── состояние ротации (localStorage) ──
interface FactsState {
  shown: Record<string, number>;   // id → ts показа
  read: Record<string, 1>;         // прочитанные — больше не показываются
  tries: Record<string, number>;   // показы без прочтения (макс 2)
  lastDay: string;                 // день последнего факта (не чаще 1/3 дней)
  lastAnyDay: string;              // день любого факта (не чаще 1/день)
}
const KEY = 'dd-facts-state';
const DAY = 86400000;

function load(): FactsState {
  try { const r = localStorage.getItem(KEY); if (r) return { shown: {}, read: {}, tries: {}, lastDay: '', lastAnyDay: '', ...JSON.parse(r) }; } catch { /* ignore */ }
  return { shown: {}, read: {}, tries: {}, lastDay: '', lastAnyDay: '' };
}
function save(s: FactsState) { localStorage.setItem(KEY, JSON.stringify(s)); }

export interface FactContext {
  todayISO: string;
  streakToday?: number;      // текущий стрик записей (если веха — сегодня)
  milestoneToday?: string;   // id факта личной вехи (ачивка сегодня) — класс 1
  gapReturnToday?: boolean;  // вернулся после пропуска — класс 2
}

/** Доступен ли факт сегодня: не прочитан, попытки < 2, повтор не раньше 5 дней. */
export function factAvailable(f: Fact, s: FactsState, now: number): boolean {
  if (s.read[f.id]) return false;
  if ((s.tries[f.id] ?? 0) >= 2) return false;
  const ts = s.shown[f.id];
  if (ts && now - ts < 5 * DAY && (s.tries[f.id] ?? 0) > 0) return false; // непрочитанный повтор — через 5 дней
  return true;
}

/** Выбор факта дня. Возвращает null, если сегодня факта не должно быть. */
export function pickFact(ctx: FactContext, opts: { factsOn: boolean }, now = Date.now()): Fact | null {
  if (!opts.factsOn) return null;
  const s = load();
  // не чаще 1 в 3 дня (триггерные классы 1–4 пробивают график в день события, но не чаще 1/день)
  const threeDaysAgo = ctx.todayISO !== s.lastDay && (s.lastDay ? now - new Date(s.lastDay).getTime() >= 3 * DAY : true);
  const milestoneOrReturn = !!(ctx.milestoneToday || ctx.gapReturnToday || ctx.streakToday);
  if (!threeDaysAgo && !milestoneOrReturn) return null;
  if (ctx.todayISO === s.lastAnyDay) return null; // один факт в день максимум

  // триггерные вехи показывают СВОЙ факт точно (веха года не выпадает новичку);
  // без триггера спонтанно идёт только «хвост» механик (всегда уместен)
  let f: Fact | undefined;
  if (ctx.milestoneToday) f = FACTS.find(x => x.id === ctx.milestoneToday && factAvailable(x, s, now));
  else if (ctx.gapReturnToday) f = FACTS.find(x => x.id === 'gap_return' && factAvailable(x, s, now));
  else if (ctx.streakToday) {
    const pool = FACTS.filter(x => x.cls === 3 && factAvailable(x, s, now));
    pool.sort((a, b) => (b.rarity - a.rarity) || ((s.shown[a.id] ?? 0) - (s.shown[b.id] ?? 0)));
    f = pool[0];
  } else {
    const pool = FACTS.filter(x => x.cls === 5 && factAvailable(x, s, now));
    pool.sort((a, b) => (b.rarity - a.rarity) || ((s.shown[a.id] ?? 0) - (s.shown[b.id] ?? 0)));
    f = pool[0];
  }
  if (!f) {
    // триггер сработал, а его факт исчерпан — хвост, чтобы не терять момент
    const pool = FACTS.filter(x => x.cls === 5 && factAvailable(x, s, now));
    pool.sort((a, b) => (b.rarity - a.rarity) || ((s.shown[a.id] ?? 0) - (s.shown[b.id] ?? 0)));
    f = pool[0];
  }
  if (!f) return null;
  s.shown[f.id] = now;
  s.lastAnyDay = ctx.todayISO;
  if (f.cls >= 3) s.lastDay = ctx.todayISO; // хвост/вехи двигают график
  save(s);
  track('fact_shown', { id: f.id, cls: f.cls });
  return f;
}

/** Закрытие карточки: ≥4 с открытой или тап по источнику = прочитан. */
export function markFactClosed(id: string, shownAt: number, viaSrc: boolean) {
  const s = load();
  const held = Date.now() - shownAt;
  if (viaSrc || held >= 4000) {
    s.read[id] = 1;
    track('fact_read', { id, viaSrc, heldMs: held });
  } else {
    s.tries[id] = (s.tries[id] ?? 0) + 1;
  }
  save(s);
}
