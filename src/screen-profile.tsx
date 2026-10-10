// Профиль: биометрия (с текущим весом), формула, цель + норма с раскладкой; «Сохранить» активна только при изменениях
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getProfile, saveProfile, calcNorma, track, getWeights, weightForecast, ensureDayNorma, type WeightPoint } from './store';
import type { Profile } from './db';
import { Segmented, Modal, cx } from './ui';
import { fmt, todayISO } from './lib';
import { NumField } from './onboarding';

const MACRO_PRESETS = [
  { key: 'balanced', pct: { p: 25, f: 30, c: 45 } },
  { key: 'mfp', pct: { p: 20, f: 30, c: 50 } },
  { key: 'protein', pct: { p: 30, f: 30, c: 40 } },
] as const;

function macroModeOf(pr: Profile): 'balanced' | 'mfp' | 'protein' | 'custom' { return pr.macroMode ?? 'balanced'; }

const DEFAULT: Profile = {
  userId: 'local', gender: 'male', age: 35, heightCm: 175,
  formula: 'mifflin', activity: 'light', goal: 'none', paceKgPerWeek: 0.5, updatedAt: 0,
};

export function ProfileScreen() {
  const [pr, setPr] = useState<Profile | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saved, setSaved] = useState(false);
  const weights = useLiveQuery(() => getWeights(), [], [] as WeightPoint[]);
  const forecast = useLiveQuery(() => weightForecast(), [], null);
  const [dayNorma, setDayNorma] = useState<import('./db').DayNorma | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => { ensureDayNorma(todayISO()).then(setDayNorma); }, [saved]);

  useEffect(() => { getProfile().then(p => { setPr(p ?? DEFAULT); setBaseline(JSON.stringify(p ?? DEFAULT)); }); }, []);
  if (!pr) return <div className="min-h-screen" />;

  const norma = calcNorma(pr);
  const dirty = JSON.stringify({ ...pr, updatedAt: 0 }) !== JSON.stringify({ ...JSON.parse(baseline || '{}'), updatedAt: 0 });
  const set = (patch: Partial<Profile>) => { setPr({ ...pr, ...patch }); setSaved(false); };

  async function save() {
    await saveProfile(pr!);
    setBaseline(JSON.stringify(pr!));
    setSaved(true);
    track('profile_saved', { goal: pr!.goal, formula: pr!.formula });
  }

  return (
    <div className="min-h-screen px-4 pt-6 pb-28">
      <h1 className="text-xl font-bold mb-4">Профиль и норма</h1>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Пол</div>
        <Segmented value={pr.gender} onChange={v => set({ gender: v })} options={[{ value: 'male', label: '♂ мужской' }, { value: 'female', label: '♀ женский' }]} />

        <div className="dd-input-row mt-2">
          <NumField label="возраст" value={pr.age} onChange={n => set({ age: n ?? 0 })} />
          <NumField label="рост, см" value={pr.heightCm} onChange={n => set({ heightCm: n ?? 0 })} />
          <NumField label="вес, кг" value={pr.weightKg} onChange={n => set({ weightKg: n })} />
        </div>
        <div className="text-[10px] mt-2" style={{ color: 'var(--mut)' }}>текущий вес — точка отсчёта нормы; изменение веса записывается как взвешивание</div>
      </div>

      <WeightCard weights={weights} forecast={forecast} />

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Активность</div>
        <div style={dayNorma?.basis === 'adaptive' ? { opacity: .45, pointerEvents: 'none' } : undefined}>
          <Segmented value={pr.activity} onChange={v => set({ activity: v })} options={[
            { value: 'sedentary', label: 'сидячая' }, { value: 'light', label: 'лёгкая' },
            { value: 'moderate', label: 'средняя' }, { value: 'active', label: 'высокая' }, { value: 'very_active', label: 'очень высокая' },
          ]} />
        </div>
        {dayNorma?.basis === 'adaptive' && (
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--acc-fg)' }}>
            ⚡ тренд — расход берётся из твоей истории (что ел + как менялся вес), ручная активность пока не участвует
          </div>
        )}
      </div>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Цель</div>
        <div className="dd-seg mt-1" style={{ display: 'flex' }}>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'lose' && 'on')} onClick={() => set({ goal: pr.goal === 'lose' ? 'none' : 'lose' })}>📉 худеть</button>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'maintain' && 'on')} onClick={() => set({ goal: pr.goal === 'maintain' ? 'none' : 'maintain' })}>⚖️ держать</button>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'gain' && 'on')} onClick={() => set({ goal: pr.goal === 'gain' ? 'none' : 'gain' })}>📈 набирать</button>
        </div>
        {pr.goal !== 'none' && (
          <>
            <div className="dd-seg mt-1.5" style={{ display: 'flex' }}>
              {[0.25, 0.5, 0.75, 1, 1.25].map(v => (
                <button key={v} style={{ flex: 1 }} className={cx(pr.paceKgPerWeek === v && 'on')}
                  onClick={() => set({ paceKgPerWeek: v })}>{String(v).replace('.', ',')}</button>
              ))}
            </div>
            <div className="flex items-end gap-3 mt-1.5">
              <div className="min-w-0" style={{ width: 130 }}>
                <div className="dd-field-label">Целевой вес, кг</div>
                <NumField label="" value={pr.goalWeightKg} onChange={n => set({ goalWeightKg: n })} />
              </div>
              {forecast && (
                <div className="flex-1 min-w-0 pb-2 text-[12px]" style={{ color: 'var(--acc-fg)' }}>
                  При вашем темпе цель будет достигнута {ruDate(forecast.etaDate)}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Распределение БЖУ</div>
        <Segmented value={macroModeOf(pr)} onChange={k => set({
          macroMode: k as 'balanced' | 'mfp' | 'protein' | 'custom',
          macroPct: k === 'custom' ? (pr.macroPct ?? { p: 30, f: 30, c: 40 }) : MACRO_PRESETS.find(x => x.key === k)!.pct,
        })} options={[
          { value: 'balanced', label: '25/30/45' }, { value: 'mfp', label: '20/30/50' },
          { value: 'protein', label: '30/30/40' }, { value: 'custom', label: 'вручную' },
        ]} />
        {macroModeOf(pr) === 'custom' && (
          <div className="dd-input-row mt-2">
            <NumField label="белки, %" value={pr.macroPct?.p} onChange={n => set({ macroPct: { ...(pr.macroPct ?? { p: 30, f: 30, c: 40 }), p: n ?? 0 } })} />
            <NumField label="жиры, %" value={pr.macroPct?.f} onChange={n => set({ macroPct: { ...(pr.macroPct ?? { p: 30, f: 30, c: 40 }), f: n ?? 0 } })} />
            <NumField label="углев., %" value={pr.macroPct?.c} onChange={n => set({ macroPct: { ...(pr.macroPct ?? { p: 30, f: 30, c: 40 }), c: n ?? 0 } })} />
          </div>
        )}
      </div>

      {norma ? (
        <div className="dd-card p-5 text-center mb-4">
          <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--mut)' }}>Дневная норма</div>
          <button onClick={() => setWhyOpen(true)} aria-label="Почему такая норма"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'block', width: '100%' }}>
            <div className="text-3xl font-extrabold dd-num mt-1" style={{ color: 'var(--acc-fg)' }}>
              {fmt(dayNorma?.kcal ?? norma.kcal)}
              {dayNorma?.basis === 'adaptive' && <span className="dd-chip-adaptive" style={{ marginLeft: 8, verticalAlign: 'middle' }}>⚡ тренд</span>}
            </div>
          </button>
          <div className="text-xs mt-1" style={{ color: 'var(--mut)' }}>ккал · Б {fmt(dayNorma?.p ?? norma.p)} г · Ж {fmt(dayNorma?.f ?? norma.f)} г · У {fmt(dayNorma?.c ?? norma.c)} г</div>
          <button onClick={() => setWhyOpen(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <div className="text-[10px] mt-2 dd-num" style={{ color: 'var(--mut)' }}>
              {dayNorma?.detail?.tdeeAdaptive
                ? `формула ${fmt(dayNorma.detail.tdeeFormula ?? 0)} → факт ${fmt(dayNorma.detail.tdeeAdaptive)} по твоей истории · почему — тап`
                : `расход ≈ ${norma.tdee}${norma.adj !== 0 ? ` → ${norma.adj > 0 ? '+' : '−'}${Math.abs(norma.adj)} по темпу` : ' · без поправки'} · почему — тап`}
            </div>
          </button>
        </div>
      ) : (
        <div className="dd-card p-4 mb-4 text-center text-xs" style={{ color: 'var(--mut)' }}>
          укажи текущий вес — посчитается норма
        </div>
      )}

      <WhyNorma open={whyOpen} onClose={() => setWhyOpen(false)} norma={dayNorma} fallback={norma} />

      <button className="dd-action strong" disabled={!dirty} onClick={save}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
    </div>
  );
}


// ── Динамика веса: спарклайн за год + тренд + прогноз цели (M1) ──
function WeightCard({ weights, forecast }: { weights: WeightPoint[] | undefined; forecast: { slopePerWeek: number; etaDate: string; trendKg: number } | null }) {
  if (!weights || weights.length === 0) return null;
  // окно 365 дней; точки прореживаем до ~120
  const last = weights[weights.length - 1].date;
  const from = new Date(new Date(last + 'T00:00:00').getTime() - 182 * 86400000).toISOString().slice(0, 10); // 6 месяцев
  const win = weights.filter(w => w.date >= from);
  const shown = win.length > 120 ? win.filter((_, i) => i % Math.ceil(win.length / 120) === 0 || i === win.length - 1) : win;
  const kgs = shown.map(w => w.kg);
  const min = Math.min(...kgs), max = Math.max(...kgs);
  const W = 300, H = 84, pad = 6;
  const x = (i: number) => pad + (W - 2 * pad) * (i / Math.max(1, shown.length - 1));
  const y = (kg: number) => pad + (H - 2 * pad) * (1 - (kg - min) / Math.max(0.1, max - min));
  const pts = shown.map((w, i) => `${x(i).toFixed(1)},${y(w.kg).toFixed(1)}`).join(' ');
  const trend = weightTrendLocal(shown);
  const y0 = trend ? y(trend.slope * 0 + trend.intercept) : 0;
  const yN = trend ? y(trend.slope * (shown.length - 1) + trend.intercept) : 0;
  const first = win[0].kg, cur = weights[weights.length - 1].kg;
  const delta = Math.round((cur - first) * 10) / 10;
  const sorted = [...kgs].sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return (
    <div className="dd-card p-4 mb-4">
      <div className="flex justify-between items-baseline">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Динамика веса</div>
        <div className="dd-num font-bold" style={{ fontSize: 13, color: delta > 0 ? 'var(--warn)' : 'var(--ok)' }}>
          {delta > 0 ? '+' : ''}{delta} кг за 6 мес
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 84 }}>
        <polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="1.5" strokeLinejoin="round" opacity=".85" />
        {trend && <line x1={x(0)} y1={y0} x2={x(shown.length - 1)} y2={yN} stroke="var(--mut)" strokeWidth="1" strokeDasharray="4 4" />}
      </svg>
      <div className="flex justify-between text-[10px] dd-num" style={{ color: 'var(--mut)' }}>
        <span>мин {fmtLocal(Math.round(min * 10) / 10)} · медиана {fmtLocal(Math.round(mid * 10) / 10)} · макс {fmtLocal(Math.round(max * 10) / 10)} кг</span>
        <span>тренд {forecast ? `−${String(forecast.slopePerWeek).replace('.', ',')} кг/нед` : '—'}</span>
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--mut)' }}>пунктир на графике — тренд (усреднённая прямая по взвешиваниям, без скачков воды и соли)</div>

    </div>
  );
}

function weightTrendLocal(points: WeightPoint[]): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const t0 = new Date(points[0].date).getTime();
  const xs = points.map(p => (new Date(p.date).getTime() - t0) / 86400000);
  const ys = points.map(p => p.kg);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  return { slope: num / den, intercept: my - (num / den) * mx };
}

const fmtLocal = (v: number) => String(v).replace('.', ',');
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function ruDate(iso: string) { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`; }


function WhyNorma({ open, onClose, norma, fallback }: {
  open: boolean; onClose: () => void;
  norma: import('./db').DayNorma | null;
  fallback: { kcal: number; p: number; f: number; c: number; bmr: number; tdee: number; adj: number } | null;
}) {
  const d = norma?.detail;
  const kcal = norma?.kcal ?? fallback?.kcal ?? 0;
  const rows: Array<[string, string]> = [];
  if (d?.bmr) rows.push(['Базовый обмен', `${fmt(d.bmr)} ккал — столько тратит тело в покое (Миффлин)`]);
  if (d?.tdeeFormula) rows.push(['Расход по формуле', `${fmt(d.tdeeFormula)} ккал — с учётом активности из профиля`]);
  if (d?.tdeeAdaptive) rows.push(['Твой факт из истории', `${fmt(d.tdeeAdaptive)} ккал — по окну ${d.windowDays} дн (${d.coverage}% дней с записями): ел в среднем ${fmt(d.intakeAvg ?? 0)}, вес изменился на ${String(d.weightDelta).replace('-', '−').replace('.', ',')} кг`]);
  if (d) { if (d.adj) rows.push(['Поправка на цель', `${d.adj > 0 ? '+' : '−'}${fmt(Math.abs(d.adj))} ккал — темп из профиля`]); }
  else if (fallback?.adj) rows.push(['Поправка на цель', `${fallback.adj > 0 ? '+' : '−'}${fmt(Math.abs(fallback.adj))} ккал — темп из профиля`]);
  rows.push(['Итог на день', `${fmt(kcal)} ккал${norma?.basis === 'adaptive' ? ' — формула, поправленная твоим фактом' : ' — по формуле'}`]);
  return (
    <Modal open={open} onClose={onClose}>
      <div className="text-[15px] font-bold mb-2">Почему такая норма</div>
      {rows.map(([k, v]) => (
        <div key={k} className="py-1.5" style={{ borderBottom: '1px solid var(--tr)' }}>
          <div className="text-[11px]" style={{ color: 'var(--mut)' }}>{k}</div>
          <div className="text-[13px]">{v}</div>
        </div>
      ))}
      {norma && <p className="dd-modal-text" style={{ marginTop: 8 }}>Норма зафиксирована за {norma.date} и не пересчитается задним числом.</p>}
      <div className="dd-modal-row">
        <button className="dd-action strong" onClick={onClose}>Понятно</button>
      </div>
    </Modal>
  );
}
