// Профиль: биометрия (с текущим весом), формула, цель + норма с раскладкой; «Сохранить» активна только при изменениях
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getProfile, saveProfile, calcNorma, track, getWeights, ensureDayNorma, type WeightPoint } from './store';
import type { Profile } from './db';
import { db } from './db';
import { Segmented, Modal, Sheet, cx } from './ui';
import { fmt, todayISO, loadSettings, HIDDEN_CATS } from './lib';
import { ACH } from './achievements';
import { loadFlags, saveFlags, BASE_FLAG_CATS, type FlagSettings } from './banner';
import { Toggle } from './ui';

const ACT_LABELS: Record<string, string> = { sedentary: 'сидячая', light: 'лёгкая', moderate: 'средняя', active: 'высокая', very_active: 'высокая' };
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
  const fileAvatar = useRef<HTMLInputElement>(null);
  const [pr, setPr] = useState<Profile | null>(null);
  // мотивационные баннеры (перенос из Настроек, В. 19.10)
  const [flags, setFlags] = useState<FlagSettings>(() => loadFlags());
  const [flagsOpen, setFlagsOpen] = useState(false);
  const catsList = useLiveQuery(async () =>
    [...new Set((await db.foods.filter(f => !f.deletedAt).toArray()).map(f => f.category))].filter(c => !HIDDEN_CATS.includes(c)).sort(), [], [] as string[]);
  const [baseline, setBaseline] = useState('');
  const [saved, setSaved] = useState(false);
  const weights = useLiveQuery(() => getWeights(), [], [] as WeightPoint[]);
  // v0.5.0: прогноз даты ушёл вместе с целевым весом (цель = темп)
  const [dayNorma, setDayNorma] = useState<import('./db').DayNorma | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => { ensureDayNorma(todayISO()).then(setDayNorma); }, [saved]);

  useEffect(() => { getProfile().then(p => { setPr(p ?? DEFAULT); setBaseline(JSON.stringify(p ?? DEFAULT)); }); }, []);
  if (!pr) return <div className="min-h-screen" />;

  const norma = calcNorma(pr); // живой расчёт от черновика: норма меняется сразу при правке целей
  const liveNorma = norma;
  const dirty = JSON.stringify({ ...pr, updatedAt: 0 }) !== JSON.stringify({ ...JSON.parse(baseline || '{}'), updatedAt: 0 });
  const set = (patch: Partial<Profile>) => { setPr({ ...pr, ...patch }); setSaved(false); };

  async function save() {
    await saveProfile(pr!);
    setBaseline(JSON.stringify(pr!));
    setSaved(true);
    // v0.5.0: день ещё не закончился — сегодняшний снапшот нормы перезаписываем (прошлые не трогаем)
    const today = todayISO();
    await db.dayNormas.delete(today).catch(() => {});
    ensureDayNorma(today).then(n => { if (n) setDayNorma(n); }); // без обнуления: тренд-режим не мигает
    track('profile_saved', { goal: pr!.goal });
  }

  return (
    <div className="min-h-screen px-4 pt-6 pb-28">
      <div className="flex items-center gap-3 mb-4">
        <button className="dd-avatar" aria-label="Сменить фото"
          onClick={() => fileAvatar.current?.click()}>
          {pr.avatar
            ? <img src={pr.avatar} alt="" />
            : <span className="text-2xl">{(pr.displayName ?? 'Я').slice(0, 1).toUpperCase()}</span>}
        </button>
        <div className="flex-1 min-w-0">
          <input className="dd-input" style={{ fontWeight: 600 }} placeholder="твоё имя"
            value={pr.displayName ?? ''} onChange={e => set({ displayName: e.target.value })} />
        </div>
      </div>
      <input ref={fileAvatar} type="file" accept="image/*" hidden
        onChange={e => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 128;
            const ctx = c.getContext('2d')!;
            const side = Math.min(img.width, img.height);
            ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
            set({ avatar: c.toDataURL('image/jpeg', 0.85) });
            track('avatar_set', {});
          };
          img.src = URL.createObjectURL(f);
        }} />

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>О себе</div>
        <Segmented value={pr.gender} onChange={v => set({ gender: v })} options={[{ value: 'male', label: '♂ мужской' }, { value: 'female', label: '♀ женский' }]} />

        <div className="dd-input-row mt-2">
          <NumField label="возраст" value={pr.age} onChange={n => set({ age: n ?? 0 })} />
          <NumField label="рост, см" value={pr.heightCm} onChange={n => set({ heightCm: n ?? 0 })} />
          {/* показываем последнее взвешивание (журнал), а не устаревший вес профиля (В., 24.10) */}
          <NumField label="вес, кг" value={weights.length ? weights[weights.length - 1].kg : pr.weightKg} onChange={n => set({ weightKg: n })} dec />
        </div>
        <div className="text-[0.625rem] mt-2" style={{ color: 'var(--mut)' }}>текущий вес — точка отсчёта нормы; изменение веса записывается как взвешивание</div>
      </div>

      <WeightCard weights={weights} />

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Активность</div>
        {(loadSettings().textScale ?? 1) > 1.05 && pr ? (
          // крупные шрифты: только текущий режим, ряд из пяти кнопок не влезает (В., 18.10)
          <div className="dd-seg" style={{ display: 'flex' }}>
            <button style={{ flex: 1 }} className="on" aria-disabled="true">
              {dayNorma?.basis === 'adaptive' ? '⚡ тренд' : ACT_LABELS[pr.activity]}
            </button>
          </div>
        ) : (
        <div className="dd-seg" style={{ display: 'flex' }}>
          <div style={{ flex: 1, display: 'flex', gap: 6, ...(dayNorma?.basis === 'adaptive' ? { opacity: .45, pointerEvents: 'none' } : {}) }}>
            <button style={{ flex: 1 }} className={cx(pr.activity === 'sedentary' && 'on')} onClick={() => set({ activity: 'sedentary' })}>сидячая</button>
            <button style={{ flex: 1 }} className={cx(pr.activity === 'light' && 'on')} onClick={() => set({ activity: 'light' })}>лёгкая</button>
            <button style={{ flex: 1 }} className={cx(pr.activity === 'moderate' && 'on')} onClick={() => set({ activity: 'moderate' })}>средняя</button>
            <button style={{ flex: 1 }} className={cx((pr.activity === 'active' || pr.activity === 'very_active') && 'on')} onClick={() => set({ activity: 'active' })}>высокая</button>
          </div>
          {dayNorma?.basis === 'adaptive' && (
            <button style={{ flex: 1 }} className="on" aria-disabled="true">⚡ тренд</button>
          )}
        </div>
        )}
        {dayNorma?.basis === 'adaptive' && (
          <div className="text-[0.6875rem] mt-1.5" style={{ color: 'var(--mut)' }}>
            расход берётся из твоей истории (что ел + как менялся вес), ручная активность пока не участвует
          </div>
        )}
      </div>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Цель</div>
        <div className="dd-seg mt-1" style={{ display: 'flex' }}>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'lose' && 'on')} onClick={() => set({ goal: pr.goal === 'lose' ? 'none' : 'lose' })}>худеть</button>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'maintain' && 'on')} onClick={() => set({ goal: pr.goal === 'maintain' ? 'none' : 'maintain' })}>держать</button>
          <button style={{ flex: 1 }} className={cx(pr.goal === 'gain' && 'on')} onClick={() => set({ goal: pr.goal === 'gain' ? 'none' : 'gain' })}>набирать</button>
        </div>
        {pr.goal === 'maintain' ? (
          <div className="text-[0.75rem] mt-2 text-center" style={{ color: 'var(--mut)' }}>норма подбирается так, чтобы вес сохранялся: {fmt(liveNorma?.kcal ?? 0)} ккал</div>
        ) : pr.goal !== 'none' && (
          <>
            <div className="dd-field-label">Темп, кг в неделю</div>
            <div className="dd-seg" style={{ display: 'flex' }}>
              {[0.25, 0.5, 0.75, 1, 1.25].map(v => (
                <button key={v} style={{ flex: 1 }} className={cx(pr.paceKgPerWeek === v && 'on')}
                  onClick={() => set({ paceKgPerWeek: v })}>{String(v).replace('.', ',')}</button>
              ))}
            </div>
            <div className="text-[0.75rem] mt-2 text-center" style={{ color: 'var(--acc-fg)' }}>
              план: −{String(pr.paceKgPerWeek ?? 0.5).replace('.', ',')} кг/нед · норма {fmt(liveNorma?.kcal ?? norma?.kcal ?? 0)} ккал
              {liveNorma && liveNorma.kcal <= Math.round(liveNorma.bmr * 1.1) && ' (пол безопасности — не ниже 1,1× обмена)'}
            </div>
          </>
        )}
      </div>

      <div className="dd-card px-4 py-1 mb-4">
        <div className="dd-field-label" style={{ marginTop: 12 }}>Мотивация</div>
        <div className="flex justify-between items-center py-3">
          <div className="text-sm">Мотивирующие баннеры</div>
          <Toggle on={flags.praise || flags.warn} onChange={v => { const f = { ...flags, praise: v, warn: v }; setFlags(f); saveFlags(f); }} />
        </div>
        <div className="pb-3">
          <button className="dd-link-btn" style={{ padding: '6px 0' }} onClick={() => setFlagsOpen(!flagsOpen)}>
            Красные флаги <span style={{ color: 'var(--mut)' }}>{flags.cats.length} категорий</span> {flagsOpen ? '▲' : '▼'}
          </button>
          {flagsOpen && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {[...BASE_FLAG_CATS, ...new Set((catsList ?? []).filter(c => !BASE_FLAG_CATS.includes(c)))].map(c => (
                <button key={c} className={flags.cats.includes(c) ? 'dd-cat-chip on' : 'dd-cat-chip'}
                  onClick={() => {
                    const cs = flags.cats.includes(c) ? flags.cats.filter(x => x !== c) : [...flags.cats, c];
                    const f = { ...flags, cats: cs }; setFlags(f); saveFlags(f);
                  }}>{c}</button>
              ))}
            </div>
          )}
        </div>

        <AchievementsRow />
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
          <div className="text-[0.6875rem] uppercase tracking-wider" style={{ color: 'var(--mut)' }}>Дневная норма{dayNorma?.retro ? ' · восстановлено задним числом' : dirty ? ' · станет после сохранения' : ''}</div>
          <button onClick={() => setWhyOpen(true)} aria-label="Почему такая норма"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'block', width: '100%' }}>
            <div className="text-3xl font-extrabold dd-num mt-1" style={{ color: 'var(--acc-fg)' }}>
              {fmt(norma.kcal)}
              {dayNorma?.basis === 'adaptive' && <span className="dd-chip-adaptive" style={{ marginLeft: 8, verticalAlign: 'middle' }}>⚡ тренд</span>}
            </div>
          </button>
          <div className="text-xs mt-1" style={{ color: 'var(--mut)' }}>ккал · Б {fmt(norma.p)} г · Ж {fmt(norma.f)} г · У {fmt(norma.c)} г</div>
          <button onClick={() => setWhyOpen(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            <div className="text-[0.625rem] mt-2 dd-num" style={{ color: 'var(--mut)' }}>
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

      {dirty && (
        <div className="dd-save-bar">
          <button className="dd-action strong" onClick={save}>Сохранить изменения</button>
        </div>
      )}
      <button className="dd-action strong" disabled={!dirty} onClick={save} style={{ visibility: dirty ? 'hidden' : 'visible' }}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
    </div>
  );
}


// ── Динамика веса: спарклайн за год + тренд + прогноз цели (M1) ──
function WeightCard({ weights }: { weights: WeightPoint[] | undefined }) {
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
        <div className="dd-num font-bold" style={{ fontSize: '0.8125rem', color: delta > 0 ? 'var(--warn)' : 'var(--ok)' }}>
          {delta > 0 ? '+' : ''}{delta} кг за 6 мес
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 84 }}>
        <polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="1.5" strokeLinejoin="round" opacity=".85" />
        {trend && <line x1={x(0)} y1={y0} x2={x(shown.length - 1)} y2={yN} stroke="var(--mut)" strokeWidth="1" strokeDasharray="4 4" />}
      </svg>
      {weights && weights.length > 0 && (
        <div className="text-[0.6875rem] dd-num" style={{ color: 'var(--mut)', marginBottom: 2 }}>
          старт (первое взвешивание): {fmtLocal(weights[0].kg)} кг · всего {(() => {
            const d = Math.round((weights[weights.length - 1].kg - weights[0].kg) * 10) / 10;
            return d > 0 ? '+' : '';
          })()}{fmtLocal(Math.round((weights[weights.length - 1].kg - weights[0].kg) * 10) / 10)} кг
        </div>
      )}
      <div className="flex justify-between text-[0.625rem] dd-num" style={{ color: 'var(--mut)' }}>
        <span>мин {fmtLocal(Math.round(min * 10) / 10)} · медиана {fmtLocal(Math.round(mid * 10) / 10)} · макс {fmtLocal(Math.round(max * 10) / 10)} кг</span>
        <span>тренд {trend ? `−${String(Math.abs(Math.round(trend.slope * 700) / 100)).replace('.', ',')} кг/нед` : '—'}</span>
      </div>
      <div className="text-[0.625rem] mt-0.5" style={{ color: 'var(--mut)' }}>пунктир на графике — тренд (усреднённая прямая по взвешиваниям, без скачков воды и соли)</div>

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
      <div className="text-[0.9375rem] font-bold mb-2">Почему такая норма</div>
      {rows.map(([k, v]) => (
        <div key={k} className="py-1.5" style={{ borderBottom: '1px solid var(--tr)' }}>
          <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>{k}</div>
          <div className="text-[0.8125rem]">{v}</div>
        </div>
      ))}
      {norma && <p className="dd-modal-text" style={{ marginTop: 8 }}>Норма зафиксирована за {norma.date} и не пересчитается задним числом.</p>}
      <div className="dd-modal-row">
        <button className="dd-action strong" onClick={onClose}>Понятно</button>
      </div>
    </Modal>
  );
}


function AchievementsRow() {
  const [open, setOpen] = useState(false);
  const mine = useLiveQuery(() => db.achievements.filter(a => a.userId === 'local' && !a.deletedAt).toArray(), [], []);
  const byCode = new Map((mine ?? []).map(a => [a.code, a] as const));
  const count = byCode.size;
  return (
    <>
      <div className="flex justify-between items-center" style={{ minHeight: 44, borderTop: '1px solid var(--tr)', marginTop: 6, paddingTop: 6 }}>
        <span className="text-sm">Достижения</span>
        <button className="dd-link-btn" style={{ color: 'var(--mut)', fontSize: '0.6875rem', fontWeight: 500 }}
          onClick={() => setOpen(true)}>{count} из {ACH.length} →</button>
      </div>
      <div className="grid grid-cols-9 gap-1">
        {ACH.filter(a => byCode.has(a.code)).slice(-9).reverse().map(a => (
          <div key={a.code} className="text-center" title={a.name} style={{ fontSize: '1.0625rem', lineHeight: 1.4 }}>{a.emoji}</div>
        ))}
      </div>

      {/* Sheet вне dd-card: fixed ломается о backdrop-filter карточки (В., 25.10: панель «висла внизу») */}
      <Sheet open={open} onClose={() => setOpen(false)} title="Достижения">
        {ACH.map(a => {
          const got = byCode.get(a.code);
          return (
            <div key={a.code} className="flex items-center gap-3" style={{ minHeight: 52, opacity: got ? 1 : .45 }}>
              <span style={{ fontSize: '1.5rem', flex: 'none', filter: got ? undefined : 'grayscale(1)' }}>{a.emoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[0.84375rem] font-semibold">{a.name}</div>
                <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>{got ? a.desc : a.hint}</div>
              </div>
              {got && <span className="dd-num text-[0.625rem] flex-none" style={{ color: 'var(--mut)' }}>
                {new Date(got.unlockedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
              </span>}
            </div>
          );
        })}
        <p className="text-[0.625rem] mt-3 text-center" style={{ color: 'var(--mut)' }}>
          после 90 дней без записей достижения начинаются заново
        </p>
      </Sheet>
    </>
  );
}
