// Достижения (v0.7.6): считаемые события → ачивки. Доска в Профиле, лента в Семье.
// Канон — docs/FACTS.md §Ачивки: названия 1–2 слова, смысловые описания в ОТНОСИТЕЛЬНЫХ
// величинах (наружу уходят только проценты/факты, не килограммы и даты).
import { db, LOCAL_USER, type Entry, type WeightLog } from './db';
import { track } from './store';
import { loadSync } from './sync';
import { todayISO } from './lib';

export interface AchDef {
  code: string;
  emoji: string;
  name: string;   // название (доска)
  desc: string;   // смысловое описание (тост семье, лента) — относительные величины
  hint: string;   // подсказка на незаряженной (доска)
}

export const ACH: AchDef[] = [
  { code: 'first_entry', emoji: '✍️', name: 'Первая запись', desc: 'начал(а) вести дневник', hint: 'Запиши первую еду' },
  { code: 'scan1', emoji: '📷', name: 'Дзынь', desc: 'впервые отсканировал(а) штрихкод', hint: 'Отсканируй штрихкод продукта' },
  { code: 'recipe1', emoji: '👨‍🍳', name: 'Повар', desc: 'собрал(а) первый рецепт', hint: 'Сохрани первый рецепт' },
  { code: 'streak3', emoji: '🔥', name: 'Разогрев', desc: 'три дня подряд с записями', hint: 'Записывай еду 3 дня подряд' },
  { code: 'streak7', emoji: '⚡', name: 'Импульс', desc: 'неделю подряд с записями', hint: 'Записывай еду 7 дней подряд' },
  { code: 'streak30', emoji: '🌊', name: 'Инерция', desc: 'месяц подряд с записями', hint: 'Записывай еду 30 дней подряд' },
  { code: 'day66', emoji: '🧠', name: 'Автомат', desc: 'привычка закрепилась: два месяца подряд', hint: 'Записывай еду 66 дней подряд' },
  { code: 'gap_return', emoji: '🛫', name: 'Второе дыхание', desc: 'вернул(ся/ась) к дневнику после паузы', hint: 'Вернись к дневнику после паузы от 3 дней' },
  { code: 'count100', emoji: '💯', name: 'Сотня', desc: 'сто записей в дневнике', hint: 'Накопи 100 записей' },
  { code: 'count1000', emoji: '🏆', name: 'Тысяча', desc: 'тысяча записей в дневнике', hint: 'Накопи 1000 записей' },
  { code: 'moment_week', emoji: '⏱', name: 'Вовремя', desc: 'каждую еду записывал(а) в момент еды всю неделю', hint: 'Неделя без вечерних пачко­вых записей' },
  { code: 'weigh_week', emoji: '⚖️', name: 'Ритм', desc: 'неделю взвешивался(ась) каждое утро', hint: 'Взвешивайся 7 дней подряд' },
  { code: 'w5', emoji: '🎉', name: 'Пятёрка', desc: 'минус 5% от стартового веса', hint: 'Сбрось 5% от стартового веса' },
  { code: 'w10', emoji: '🥇', name: 'Десятка', desc: 'минус 10% от стартового веса', hint: 'Сбрось 10% от стартового веса' },
  { code: 'day30', emoji: '🗓', name: 'Месяц в игре', desc: 'месяц стажа с первой записи', hint: '30 дней с первой записи' },
  { code: 'day100', emoji: '💎', name: 'Сотня дней', desc: 'сто дней стажа', hint: '100 дней с первой записи' },
  { code: 'day180', emoji: '🏔', name: 'Топ-3%', desc: 'полгода стажа', hint: '180 дней с первой записи' },
  { code: 'day365', emoji: '🎯', name: 'Легенда', desc: 'год с дневником', hint: '365 дней с первой записи' },
];

function isoOf(d: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function todayISOOffset(base: string, off: number): string { const d = new Date(base + 'T00:00:00'); d.setDate(d.getDate() + off); return isoOf(d); }

/** Начало последнего непрерывного сегмента дневника: пауза ≥90 дней начинает новый
 *  (чистая логика — под тестами; кейс В.: после месяцев паузы «1000 дней» — бессмыслица). */
export function lastSegmentStart(days: string[]): string | null {
  if (!days.length) return null;
  let start = days[0];
  for (let i = 1; i < days.length; i++) {
    const gap = Math.round((new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86400000);
    if (gap >= 90) start = days[i];
  }
  return start;
}

export const achByCode = (code: string) => ACH.find(a => a.code === code);

/** Разовый детектор: вызывается при app_open и после добавления записи/веса/скана/рецепта.
 *  Идемпотентен: заработанное пишется один раз (id = userId|code), событие — тоже. */
export async function detectAchievements(): Promise<string[]> {
  const [entries, weights, mine] = await Promise.all([
    db.entries.where('userId').equals(LOCAL_USER).filter(e => !e.deletedAt).toArray(),
    db.weightLogs.where('userId').equals(LOCAL_USER).filter(w => !w.deletedAt).toArray(),
    db.achievements.toArray(),
  ]);
  const have = new Set(mine.map(a => a.code));
  const unlocked: string[] = [];

  // ── эпоха живого дневника (В., 25.10, разбирательство №2): достижения считаем только по
  // записям, сделанным в приложении — импортированная история (MFP и пр.) не «накручивает»
  // стаж. Граница: первый запуск устройства (события метрик) либо ранний createdAt записей.
  const firstOpen = (await db.events.orderBy('ts').first())?.ts;
  const minCreated = entries.length ? Math.min(...entries.map(e => e.createdAt ?? 0)) : Infinity;
  const eraStartMs = Math.min(firstOpen ?? Infinity, minCreated);
  const liveEntries = entries.filter(e => new Date(e.date + 'T00:00:00').getTime() >= new Date(eraStartMs).setHours(0, 0, 0, 0));

  // ── сегмент непрерывности: пауза ≥90 дней обнуляет достижения — хвостовая ИЛИ внутренняя
  // («1000 дней» у вернувшегося после месяцев паузы — бессмыслица; сброс с прямым сообщением)
  const allDays = [...new Set(liveEntries.map(e => e.date))].sort();
  const segStart = lastSegmentStart(allDays) ?? todayISO();
  const segEntries = liveEntries.filter(e => e.date >= segStart);
  const days = [...new Set(segEntries.map(e => e.date))].sort();
  const segStartMs = new Date(segStart + 'T00:00:00').getTime();

  // ачивки, заработанные до текущего сегмента (или до границы эпохи), — в tombstone
  const stale = mine.filter(a => !a.deletedAt && a.unlockedAt < segStartMs);
  if (stale.length) {
    const now3 = Date.now();
    await Promise.all(stale.map(a => db.achievements.update(a.id, { deletedAt: now3, updatedAt: now3 })));
    localStorage.setItem('dd-ach-reset', '1');
    track('achievement_reset', { reason: 'segment', count: stale.length });
  }

  const daySet = new Set(days);
  const today = todayISO();
  // стрик до сегодня (включительно, если сегодня есть запись; иначе до вчера)
  let streak = 0;
  for (let d = new Date(today + 'T00:00:00'); ; d.setDate(d.getDate() - 1)) {
    const iso = isoOf(d);
    if (daySet.has(iso)) streak++;
    else if (iso === today) continue;      // сегодня ещё может быть впереди
    else break;
  }
  // стаж и стрик-вехи
  const firstDay = days[0];
  const spanDays = firstDay ? Math.round((new Date(today).getTime() - new Date(firstDay).getTime()) / 86400000) + 1 : 0;
  const streakMilestones: Record<number, string> = { 3: 'streak3', 7: 'streak7', 30: 'streak30', 66: 'day66' };
  for (const [n, code] of Object.entries(streakMilestones)) {
    if (streak >= Number(n) && !have.has(code)) unlocked.push(code);
  }
  const spanMilestones: Record<number, string> = { 30: 'day30', 100: 'day100', 180: 'day180', 365: 'day365' };
  for (const [n, code] of Object.entries(spanMilestones)) {
    if (spanDays >= Number(n) && !have.has(code)) unlocked.push(code);
  }
  // возврат после паузы
  if (days.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < days.length; i++) {
      gaps.push(Math.round((new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86400000));
    }
    // сколько дней подряд велся дневник ДО последней паузы
    const preStreak = (() => { let s2 = 1; for (let i = gaps.length - 2; i >= 0 && gaps[i] === 1; i--) s2++; return s2; })();
    if (gaps[gaps.length - 1] >= 3 && preStreak >= 3 && !have.has('gap_return')) unlocked.push('gap_return');
  }
  // счётчики
  if (segEntries.length >= 1 && !have.has('first_entry')) unlocked.push('first_entry');
  if (segEntries.length >= 100 && !have.has('count100')) unlocked.push('count100');
  if (segEntries.length >= 1000 && !have.has('count1000')) unlocked.push('count1000');
  // неделя «в момент еды»: 7 последних дней, каждый с записями, без вечерней пачки
  // (записи дня созданы в течение дня: createdAt не позже 21:00 и разбросаны)
  const last7 = Array.from({ length: 7 }, (_, i) => todayISOOffset(today, -i));
  if (last7.every(d => daySet.has(d)) && !have.has('moment_week')) {
    const okWeek = last7.every(d => segEntries.filter(e => e.date === d).every(e => {
      const t = e.timeEaten || '';
      return !!t && t < '21:00'; // упрощённый критерий v1 (см. FACTS.md)
    }));
    if (okWeek) unlocked.push('moment_week');
  }
  // неделя взвешиваний
  const wDays = new Set(weights.map(w => w.date));
  if (last7.every(d => wDays.has(d)) && !have.has('weigh_week')) unlocked.push('weigh_week');
  // вехи веса: текущий (последний) вес от стартового (первого)
  if (weights.length >= 2) {
    const ws = weights.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const start = ws[0].weightKg, cur = ws[ws.length - 1].weightKg;
    if (start > 0 && cur <= start * 0.95 && !have.has('w5')) unlocked.push('w5');
    if (start > 0 && cur <= start * 0.90 && !have.has('w10')) unlocked.push('w10');
  }

  const now = Date.now();
  const nick = loadSync()?.nickname;
  for (const code of unlocked) {
    await db.achievements.add({
      id: 'local|' + code, userId: 'local', code, nick, unlockedAt: now, updatedAt: now, deletedAt: null,
    });
    track('achievement_unlocked', { code });
  }
  return unlocked;
}

/** Пометить события/скан/рецепт-ачивки (они не выводятся из записей). */
export async function unlockSpecial(code: 'scan1' | 'recipe1'): Promise<void> {
  const have = await db.achievements.where('code').equals(code).first();
  if (have) return;
  const now = Date.now();
  await db.achievements.add({ id: 'local|' + code, userId: 'local', code, nick: loadSync()?.nickname, unlockedAt: now, updatedAt: now, deletedAt: null });
  track('achievement_unlocked', { code });
}

export type { Entry, WeightLog };
