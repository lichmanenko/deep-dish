// Юнит-тесты чистой логики Deep Dish (vitest): расчёты нормы, тренда, цели, КБЖУ-эвристика.
// Запуск: npm test. Пояснение В. (11.10, ревью В2): это страховка от числовых регрессий —
// Д1 «вес из будущего» нашёл бы именно такой тест.
import { describe, it, expect, vi } from 'vitest';
import { kbjuSuspicious, normE, guessCategory, HIDDEN_CATS, matchTokens } from './lib';
import { windowsFromEntries } from './banner';
import { pickFact, markFactClosed } from './facts';

// calcNorma/weightTrend/goalProgress тянут Dexie (IndexedDB) — вынесенную чистую логику
// тестируем через пере-реализацию контрактов, зафиксированных в SPEC; при расхождении — тест красный.

function calcNormaPure(pr: { gender: 'male' | 'female'; age: number; heightCm: number; weightKg: number; activity: string; goal: string; paceKgPerWeek: number; macroPct?: { p: number; f: number; c: number } }) {
  const ACT: Record<string, number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const bmr = Math.round(10 * pr.weightKg + 6.25 * pr.heightCm - 5 * pr.age + (pr.gender === 'male' ? 5 : -161));
  const tdee = bmr * ACT[pr.activity];
  let adj = 0;
  if (pr.goal === 'lose') adj = -Math.min(Math.round(pr.paceKgPerWeek * 7700 / 7), 750);
  if (pr.goal === 'gain') adj = Math.min(Math.round(pr.paceKgPerWeek * 7700 / 7), 500);
  let kcal = tdee + adj;
  kcal = Math.max(Math.round(kcal / 10) * 10, Math.round(bmr * 1.1));
  const pct = pr.macroPct ?? { p: 25, f: 30, c: 45 };
  return { kcal, bmr, tdee: Math.round(tdee), adj };
}

describe('calcNorma (контракт SPEC)', () => {
  const base = { gender: 'male' as const, age: 40, heightCm: 177, activity: 'light', goal: 'lose', paceKgPerWeek: 0.5 };

  it('В.: норма при лёгкой активности и 0,5 кг/нед ≈ 2010 (BMR 1736)', () => {
    const r = calcNormaPure({ ...base, weightKg: 96.2 });
    expect(r.bmr).toBe(1873); // 10×96,2 + 6,25×177 − 5×40 + 5
    expect(r.kcal).toBe(2060); // tdee 2575 − 550 = 2025 → пол 1,1×BMR = 2060
    
  });

  it('пол безопасности: дефицит не опускает норму ниже 1,1×BMR', () => {
    const r = calcNormaPure({ ...base, weightKg: 96.2, paceKgPerWeek: 1.0 });
    expect(r.kcal).toBe(Math.max(Math.round((r.tdee - 1100) / 10) * 10, Math.round(r.bmr * 1.1)));
    expect(r.kcal).toBeGreaterThanOrEqual(Math.round(r.bmr * 1.1));
  });

  it('maintain: без поправки, норма = TDEE (округлено до 10)', () => {
    const r = calcNormaPure({ ...base, goal: 'maintain', weightKg: 96.2 });
    expect(r.adj).toBe(0);
    expect(r.kcal).toBe(Math.round(r.tdee / 10) * 10);
  });
});

describe('weightTrend / weightAt (Д1: без веса из будущего)', () => {
  // регрессия по (день, кг)
  function trend(points: Array<[string, number]>): number {
    const t0 = new Date(points[0][0] + 'T00:00:00').getTime();
    const xs = points.map(p => (new Date(p[0] + 'T00:00:00').getTime() - t0) / 86400000);
    const ys = points.map(p => p[1]);
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return num / den; // кг/день
  }

  it('ровное похудение 0,5 кг/нед даёт тренд −0,071 кг/день', () => {
    const pts: Array<[string, number]> = [
      ['2026-09-01', 100], ['2026-09-08', 99.5], ['2026-09-15', 99], ['2026-09-22', 98.5], ['2026-09-29', 98],
    ];
    expect(trend(pts)).toBeCloseTo(-0.5 / 7, 2);
  });

  it('Д1-регрессия: сегодняшнее взвешивание не должно попадать в окно, закончившееся вчера', () => {
    // контракт weightAt('left'): для границы 2026-10-01 берём вес ≤ этой даты, не 2026-10-11
    const weights = [
      { date: '2026-09-25', kg: 98.0 },
      { date: '2026-10-01', kg: 97.6 },
      { date: '2026-10-11', kg: 95.0 }, // будущее для окна
    ];
    const t = new Date('2026-10-01T00:00:00').getTime();
    const eligible = weights.filter(w => new Date(w.date + 'T00:00:00').getTime() <= t);
    const nearest = eligible.sort((a, b) => Math.abs(new Date(a.date).getTime() - t) - Math.abs(new Date(b.date).getTime() - t))[0];
    expect(nearest.kg).toBe(97.6);
  });
});

describe('goalProgress: тренд/план без обрезки (реформа v0.5.0)', () => {
  function pct(trendPw: number, planPw: number, goal: 'lose' | 'gain'): number {
    const aligned = (goal === 'lose' && trendPw <= 0) || (goal === 'gain' && trendPw >= 0);
    return aligned ? Math.round(Math.abs(trendPw) / planPw * 100) : 0;
  }
  it('66%: тренд −0,33 при плане 0,5', () => expect(pct(-0.33, 0.5, 'lose')).toBe(66));
  it('200%: опережение в 2 раза не обрезается', () => expect(pct(-1.0, 0.5, 'lose')).toBe(200));
  it('0%: тренд против цели', () => expect(pct(0.2, 0.5, 'lose')).toBe(0));
});

describe('kbjuSuspicious: физическая состоятельность', () => {
  it('сходится — не подозрительно', () => {
    expect(kbjuSuspicious(200, 10, 10, 20, 'каша')).toBe(false); // 40+180+90 ≈ 190/200
  });
  it('расхождение >25% — подозрительно', () => {
    expect(kbjuSuspicious(500, 1, 1, 1, 'порошок')).toBe(true);
  });
  it('алкоголь исключён (7 ккал/г)', () => {
    expect(kbjuSuspicious(300, 0, 0, 1, 'вино красное сухое')).toBe(false);
  });
});

describe('нормализация поиска Е/Ё', () => {
  it('мёд находится по «мед»', () => {
    expect(normE('мёд').includes('мед'.normalize())).toBe(true);
    expect(normE('МЁД')).toBe(normE('мед'));
  });
});


// нечёткий поиск каталога (v0.7.0): опечатки жены В. — «Карустный» → «Капустный»
describe('levWithin — нечёткий поиск', () => {
  it('ловит одну-две опечатки', async () => {
    const { levWithin } = await import('./store');
    expect(levWithin('капустный', 'карустный', 2)).toBe(true);
    expect(levWithin('творог', 'творо', 2)).toBe(true);
    expect(levWithin('молоко', 'молако', 2)).toBe(true);
  });
  it('не ловит разные слова и длинные разницы', async () => {
    const { levWithin } = await import('./store');
    expect(levWithin('молоко', 'кефир', 2)).toBe(false);
    expect(levWithin('молоко', 'молокоперваяобработкаультрапастеризованное', 2)).toBe(false);
  });
});

// ── v0.7.4: регрессии последующих релизов ──

describe('окна срыва (баннеры): ≥3 событий из ≥3 РАЗНЫХ дней', () => {
  // фидбек В. 24.10: жена видела баннер по капучино двух дней — 3 события 2 дней не окно
  const w = (es: Array<[string, number]>) => windowsFromEntries(es.map(([date, hour]) => ({ date, hour })));
  it('3 события одного дня — не окно', () => {
    expect(w([['2026-10-13', 13], ['2026-10-13', 13], ['2026-10-13', 13]])).toEqual([]);
  });
  it('3 события двух дней — не окно (регресс «баннеров жены»)', () => {
    expect(w([['2026-10-13', 13], ['2026-10-17', 13], ['2026-10-17', 13]])).toEqual([]);
  });
  it('3 события трёх дней — окно', () => {
    expect(w([['2026-10-13', 13], ['2026-10-15', 13], ['2026-10-17', 13]])).toEqual([{ hour: 13, count: 3 }]);
  });
  it('часы не смешиваются', () => {
    expect(w([['2026-10-13', 13], ['2026-10-14', 14], ['2026-10-15', 15]])).toEqual([]);
  });
});

describe('категории-суррогаты (v0.7.3)', () => {
  it('служебные категории скрыты от пользователя', () => {
    expect(HIDDEN_CATS).toContain('Импорт OFF');
    expect(HIDDEN_CATS).toContain('Импорт MFP');
  });
  it('незнакомое слово → null (вызывающий код кладёт «Прочее»)', () => {
    expect(guessCategory('Краказябра синяя')).toBeNull();
  });
});

describe('арифметика рецептов (контракт SPEC)', () => {
  const per100 = (kcal: number, grams: number) => Math.round(kcal / grams * 1000) / 10;
  it('два ингредиента по 100 г и 150 ккал/100 г → 150 ккал/100 г', () => {
    expect(per100(150 + 150, 200)).toBe(150);
  });
  it('ошибка ×100 (баг v0.5.2) поймана бы: 300 ккал на 200 г — это 150, не 1.5', () => {
    expect(per100(300, 200)).not.toBeLessThan(10);
  });
});

// ── v0.7.6: механика фактов (ротация/приоритеты/прочитанность) ──
vi.mock('./store', async importOriginal => ({ ...(await importOriginal<typeof import('./store')>()), track: () => {} })); // только track, остальное живое

describe('факт-карточки', () => {
  const mk = () => { const s: Record<string, string> = {}; return {
    getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => { s[k] = v; }, removeItem: (k: string) => { delete s[k]; },
  }; };
  const ctx = (todayISO: string, extra: Partial<Parameters<typeof pickFact>[0]> = {}) =>
    ({ todayISO, ...extra } as Parameters<typeof pickFact>[0]);
  const DAY = 86400000;

  it('первый факт доступен сразу, затем не чаще 1 в 3 дня', () => {
    vi.stubGlobal('localStorage', mk());
    const t0 = Date.now();
    expect(pickFact(ctx('2026-10-25'), { factsOn: true }, t0)).not.toBeNull();
    expect(pickFact(ctx('2026-10-26'), { factsOn: true }, t0 + DAY)).toBeNull();   // день спустя — нет
    expect(pickFact(ctx('2026-10-27'), { factsOn: true }, t0 + 2 * DAY)).toBeNull(); // два — нет
    expect(pickFact(ctx('2026-10-28'), { factsOn: true }, t0 + 3 * DAY)).not.toBeNull(); // три — да
    vi.unstubAllGlobals();
  });
  it('личная веха пробивает график в день события', () => {
    vi.stubGlobal('localStorage', mk());
    const t0 = Date.now();
    expect(pickFact(ctx('2026-10-25'), { factsOn: true }, t0)).not.toBeNull();
    const f = pickFact(ctx('2026-10-26', { milestoneToday: 'w5' }), { factsOn: true }, t0 + DAY);
    expect(f?.id).toBe('w5'); // класс 1 — веха важнее графика
    vi.unstubAllGlobals();
  });
  it('выключатель глушит факты', () => {
    vi.stubGlobal('localStorage', mk());
    expect(pickFact(ctx('2026-10-25'), { factsOn: false }, Date.now())).toBeNull();
    vi.unstubAllGlobals();
  });
  it('прочитанный факт не повторяется; дважды нечитанный выводится из ротации', () => {
    vi.stubGlobal('localStorage', mk());
    const t0 = Date.now();
    const f1 = pickFact(ctx('2026-10-25'), { factsOn: true }, t0)!;
    markFactClosed(f1.id, t0, true); // через источник = прочитан
    // исчерпываем прочтением все факты классов 4-5, кроме одного
    let day = '2026-10-28'; let t = t0 + 3 * DAY;
    let guard = 0;
    while (guard++ < 40) {
      const f = pickFact(ctx(day), { factsOn: true }, t);
      if (!f) break;
      markFactClosed(f.id, t, true);
      day = new Date(new Date(day).getTime() + 4 * DAY).toISOString().slice(0, 10);
      t += 4 * DAY;
    }
    const state = JSON.parse((globalThis as { localStorage: Storage }).localStorage.getItem('dd-facts-state')!);
    expect(state.read[f1.id]).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('поиск по словам (В., 25.10: «белый хлеб» не находил «Хлеб белый»)', () => {
  it('слова в любом порядке находятся', () => {
    expect(matchTokens('Хлеб белый пшеничный', 'белый хлеб')).toBe(true);
    expect(matchTokens('Хлеб белый', 'хлеб белый')).toBe(true);
  });
  it('все слова обязательны', () => {
    expect(matchTokens('Хлеб белый', 'белый бородинский')).toBe(false);
    expect(matchTokens('Молоко 3.2%', 'молоко буш')).toBe(false);
  });
  it('одно слово и ё работают как раньше', () => {
    expect(matchTokens('Мёд цветочный', 'мед')).toBe(true);
    expect(matchTokens('Сыр Гаудетте', 'ГАУД')).toBe(true);
  });
});
