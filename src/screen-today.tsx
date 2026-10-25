function MacroChip({ v, goal, k, compact }: { v: number; goal?: number; k: string; compact?: boolean }) {
  const over = goal !== undefined && v > goal;
  return (
    <div className="dd-card flex-1 text-center py-2.5">
      <div className="text-[0.9375rem] font-bold dd-num flex items-center justify-center gap-1" style={over ? { color: 'var(--warn)' } : undefined}>
        {compact && <span>{k[0].toUpperCase()}</span>}
        {fmt(v)} г{over && <span className="text-[0.6875rem]">▲</span>}
      </div>
      {!compact && <div className="text-[0.6875rem] mt-0.5" style={{ color: 'var(--mut)' }}>{k}{goal !== undefined ? ` · ${fmt(goal)}` : ''}</div>}
    </div>
  );
}

// Экран «Сегодня»: кольцо нормы, чипы БЖУ, слоты с записями, навигация по датам
import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Entry, type Slot, type SlotMark } from './db';
import type { DayNorma } from './db';
import { getEntries, getProfile, deleteEntry, saveEntry, track, saveMealFromSlot, ensureDayNorma, goalProgress, getSlotMarks, toggleSlotMark, type GoalProgress } from './store';
import { shiftISO, todayISO, humanDate, fromISO, MONTHS_NOM, fmt, loadSettings } from './lib';
import { Ring, Sheet, useSwipe, Slide, Confirm, cx, Modal, LogoMark } from './ui';

export function TodayScreen({ date, setDate, onAdd, showTime }: {
  date: string; setDate: (d: string) => void; onAdd: (slot: Slot | null) => void; showTime: 'snacks' | 'all';
}) {
  const entries = useLiveQuery(() => getEntries(date), [date], [] as Entry[]);
  const slots = useLiveQuery(() => dbSlots(), [], [] as Slot[]);
  const profile = useLiveQuery(() => getProfile(), []);
  // крупные шрифты: в кольцах и чипах только числа, подписи-слова скрыты (В., 17.10)
  const compact = useMemo(() => (loadSettings().textScale ?? 1) > 1.05, []);
  // норма дня: снапшот, фиксируется за днём при первом просмотре (прошлое не пересчитывается)
  const [norma, setNorma] = useState<DayNorma | null>(null);
  useEffect(() => { ensureDayNorma(date).then(setNorma); }, [date, profile?.updatedAt]);

  const [dir, setDir] = useState<0 | -1 | 1>(0);
  const [ringMode, setRingMode] = useState<'kcal' | 'macro'>(localStorage.getItem('dd-ringmode') === 'macro' ? 'macro' : 'kcal');
  function toggleRingMode() {
    setRingMode(m => { const v = m === 'kcal' ? 'macro' : 'kcal'; localStorage.setItem('dd-ringmode', v); return v; });
    track('ring_mode_tap');
  }
  const [calOpen, setCalOpen] = useState(false);
  const [slotInfo, setSlotInfo] = useState<Slot | null>(null);
  const marks = useLiveQuery(() => getSlotMarks(), [], [] as SlotMark[]);
  const [editEntry, setEditEntry] = useState<Entry | null>(null);
  const [confirmDel, setConfirmDel] = useState<Entry | null>(null);
  const [explain, setExplain] = useState<null | { title: string; text: string }>(null);
  const [goalInfo, setGoalInfo] = useState(false);
  const goal = useLiveQuery(() => goalProgress(date), [date], null);
  const totals = useMemo(() => entries.reduce((s, e) => ({
    kcal: s.kcal + e.snapshot.kcal, p: s.p + e.snapshot.p, f: s.f + e.snapshot.f, c: s.c + e.snapshot.c,
  }), { kcal: 0, p: 0, f: 0, c: 0 }), [entries]);

  const target = norma?.kcal ?? 2100;
  const percent = target ? Math.min(999, Math.round(totals.kcal / target * 100)) : 0;
  const rest = Math.max(0, target - totals.kcal);

  const swipe = useSwipe(
    () => { setDate(shiftISO(date, 1)); setDir(-1); },
    () => { setDate(shiftISO(date, -1)); setDir(1); },
  );

  const filledDays = useLiveQuery(async () => {
    const es = await db.entries.filter(e => !e.deletedAt).toArray();
    const s = new Set<string>();
    es.forEach((e: Entry) => s.add(e.date));
    return s;
  }, [], new Set<string>());

  return (
    <div className="min-h-screen px-4 pt-6 pb-28" {...swipe}>
      {/* дата слева, лого справа — симметричные отступы от краёв */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center">
          <button className="dd-arrow" onClick={() => { setDate(shiftISO(date, -1)); setDir(1); }} aria-label="Предыдущий день">‹</button>
          <button onClick={() => setCalOpen(true)} className="text-left px-0.5">
            <div className="text-[1.125rem] font-bold tracking-tight leading-tight">{humanDate(date)}</div>
          </button>
          <button className="dd-arrow" onClick={() => { setDate(shiftISO(date, 1)); setDir(-1); }} aria-label="Следующий день">›</button>
        </div>
        <div className="flex items-center gap-1.5">
          <LogoMark size={22} />
          <span className="text-[1.125rem] font-bold tracking-tight" style={{ color: 'var(--tx)' }}>deep dish</span>
        </div>
      </div>

      {/* AlwaysOn-зона (В., 24.10): кольца, чипы БЖУ и кнопка записи закреплены — приёмы скроллятся под ними */}
      <div className="dd-alwayson">
        {!norma && (
          <div className="dd-card p-3 mb-2 text-xs text-center" style={{ color: 'var(--mut)' }}>
            Заполни профиль — появится дневная норма и кольцо. <b style={{ color: 'var(--acc-fg)' }}>Профиль →</b>
          </div>
        )}
        <div className="dd-card p-4 mb-2">
          <div className="grid grid-cols-3 items-center">
            <div className="flex justify-center">
              <button aria-label="Переключить кольцо" onClick={toggleRingMode} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                {ringMode === 'kcal' ? (
                  <Ring percent={percent}>
                    <div className="text-lg font-extrabold dd-num">{fmt(rest)}</div>
                    {!compact && <div className="text-[0.625rem]" style={{ color: 'var(--mut)' }}>осталось</div>}
                  </Ring>
                ) : (
                  <MacroRing p={totals.p * 4} f={totals.f * 9} c={totals.c * 4} cap={target}>
                    <div className="text-lg font-extrabold dd-num">{fmt(rest)}</div>
                    {!compact && <div className="text-[0.625rem]" style={{ color: 'var(--mut)' }}>осталось</div>}
                  </MacroRing>
                )}
              </button>
            </div>
            <div className="text-center px-1">
              <div className="text-xl font-bold dd-num">{fmt(totals.kcal)}</div>
              {!compact
                ? <div className="text-xs mt-1" style={{ color: 'var(--mut)' }}>из {fmt(target)} · {percent}%</div>
                : <div className="text-xs mt-1 dd-num" style={{ color: 'var(--mut)' }}>{percent}%</div>}
              {percent > 100 && <div className="text-xs mt-1" style={{ color: 'var(--warn)' }}>↑ перебор на {fmt(totals.kcal - target)}</div>}
            </div>
            <div className="flex justify-center">
              {goal && <GoalRing goal={goal} compact={compact} onTap={() => setGoalInfo(true)} />}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mb-2">
          <MacroChip v={totals.p} goal={norma?.p} k="белки" compact={compact} />
          <MacroChip v={totals.f} goal={norma?.f} k="жиры" compact={compact} />
          <MacroChip v={totals.c} goal={norma?.c} k="углев." compact={compact} />
        </div>

        <button className="dd-action" onClick={() => onAdd(null)}>＋ еда</button>
      </div>

      <Slide dir={dir}>
        {(slots ?? []).map(slot => {
          const es = entries.filter(e => e.slotId === slot.id);
          const sum = es.reduce((s, e) => s + e.snapshot.kcal, 0);
          return (
            <div key={slot.id} className="dd-card px-4 pt-4 pb-3 mb-2.5" onClick={() => es.length === 0 && onAdd(slot)}>
              <div className="flex justify-between items-baseline mb-1">
                <button className="text-[0.9375rem] font-semibold flex items-baseline gap-2 dd-slot-link"
                  onClick={e => { e.stopPropagation(); setSlotInfo(slot); }}>
                  <span>{slot.emoji}</span>{slot.name}
                </button>
                <div className="text-xs dd-num flex items-center" style={{ color: 'var(--mut)' }}>
                  {es.length
                    ? <span className="dd-num font-bold" style={{ fontSize: '0.9375rem', color: 'var(--tx)' }}>{fmt(sum)} ккал</span>
                    : (marks ?? []).some(m => m.date === date && m.slotId === slot.id) ? 'не учтён' : 'ничего'}
                </div>
              </div>
              {es.map(e => (
                <EntryLine key={e.id} e={e} slot={slot} showTime={showTime} onClick={() => setEditEntry(e)} />
              ))}
              <div className="dd-slot-add" onClick={() => onAdd(slot)}>＋ добавить</div>
            </div>
          );
        })}
      </Slide>

      <Calendar open={calOpen} date={date} onClose={() => setCalOpen(false)} onPick={d => { setDate(d); setCalOpen(false); }} filled={filledDays} />

      <EntryEditModal entry={editEntry} onClose={() => setEditEntry(null)} />
      <Modal open={!!explain} onClose={() => setExplain(null)}>
        <div className="text-[0.9375rem] font-bold mb-2">{explain?.title}</div>
        <p className="dd-modal-text">{explain?.text}</p>
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => setExplain(null)}>Понятно</button>
        </div>
      </Modal>


      <SlotInfoSheet
        open={!!slotInfo} slot={slotInfo} date={date}
        marked={!!slotInfo && (marks ?? []).some(m => m.date === date && m.slotId === slotInfo.id)}
        entries={(slotInfo ? entries.filter(e => e.slotId === slotInfo.id) : [])}
        macroPct={profile?.macroPct}
        onClose={() => setSlotInfo(null)}
        onSave={async name => { if (slotInfo) { await saveMealFromSlot(name, slotInfo.id, date); setSlotInfo(null); } }}
      />

      <Modal open={goalInfo} onClose={() => setGoalInfo(false)}>
        <div className="text-[0.9375rem] font-bold mb-2">Прогресс цели</div>
        {(() => {
          if (!goal) return <p className="dd-modal-text">Кольцо появляется при цели «худеть» или «набирать». При «держать» оно скрыто.</p>;
          const rows: Array<[string, string]> = [
            ['Плановый темп', `${String(goal.planPw).replace('.', ',')} кг/нед — выбран в профиле`],
            ['Фактический тренд', `${goal.mode === 'lose' ? (goal.trendPw < 0 ? '−' : '+') : (goal.trendPw >= 0 ? '+' : '−')}${String(Math.abs(goal.trendPw)).replace('.', ',')} кг/нед за 8 недель`],
            ['Выполнение плана', `${goal.pct}%${goal.pct >= 100 ? ' — план перевыполнен' : goal.pct > 0 ? ' — часть плана' : ' — тренд пока против цели'}`],
          ];
          return (
            <>
              {rows.map(([k, v]) => (
                <div key={k} className="py-1.5" style={{ borderBottom: '1px solid var(--tr)' }}>
                  <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>{k}</div>
                  <div className="text-[0.8125rem]">{v}</div>
                </div>
              ))}
              {goal.tooFast && (
                <p className="dd-modal-text" style={{ marginTop: 8, color: 'var(--warn)' }}>
                  Существенно быстрее плана: при похудении это риск потери мышц, при наборе — жира. Подумай о темпе помягче.
                </p>
              )}
              <p className="dd-modal-text" style={{ marginTop: 8 }}>
                Как считаем: тренд — усреднённая прямая по взвешиваниям за 8 недель, замыкается по вчерашнему дню —
                сегодняшний вес и еда повлияют на кольцо только завтра. Прогресс = тренд / план, без верхней границы.
                Зафиксирован за этим днём и не пересчитывается задним числом.
              </p>
            </>
          );
        })()}
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => setGoalInfo(false)}>Понятно</button>
        </div>
      </Modal>

      <Confirm
        open={!!confirmDel}
        text="Удалить запись?"
        onCancel={() => setConfirmDel(null)}
        onOk={() => { if (confirmDel) { deleteEntry(confirmDel.id); track('entry_deleted'); setConfirmDel(null); } }}
      />
    </div>
  );
}

/** Шит приёма: состав, статистика, сбалансированность, сохранение как приём */
function SlotInfoSheet({ open, slot, entries, macroPct, date, marked, onClose, onSave }: {
  open: boolean; slot: Slot | null; entries: Entry[]; date: string;
  macroPct?: { p: number; f: number; c: number };
  marked: boolean;
  onClose: () => void; onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (slot) setName(`мой ${slot.name.toLowerCase()}`); }, [slot?.id]);
  if (!slot) return null;
  const t = entries.reduce((s, e) => ({ kcal: s.kcal + e.snapshot.kcal, p: s.p + e.snapshot.p, f: s.f + e.snapshot.f, c: s.c + e.snapshot.c }), { kcal: 0, p: 0, f: 0, c: 0 });
  const kc = { p: t.p * 4, f: t.f * 9, c: t.c * 4 };
  const sum = Math.max(1, kc.p + kc.f + kc.c);
  const pct = profile0(macroPct);
  const share = { p: kc.p / sum, f: kc.f / sum, c: kc.c / sum };
  const verdicts: string[] = [];
  if (t.kcal === 0) verdicts.push('приём пустой');
  else {
    if (Math.abs(share.p - pct.p / 100) > 0.12) verdicts.push(share.p > pct.p / 100 ? `белка больше плана (${Math.round(share.p * 100)}% против ${pct.p}%)` : `белка меньше плана (${Math.round(share.p * 100)}% против ${pct.p}%)`);
    if (Math.abs(share.f - pct.f / 100) > 0.12) verdicts.push(share.f > pct.f / 100 ? `жиров больше плана (${Math.round(share.f * 100)}% против ${pct.f}%)` : `жиров меньше плана (${Math.round(share.f * 100)}% против ${pct.f}%)`);
    if (Math.abs(share.c - pct.c / 100) > 0.12) verdicts.push(share.c > pct.c / 100 ? `углеводов больше плана (${Math.round(share.c * 100)}% против ${pct.c}%)` : `углеводов меньше плана (${Math.round(share.c * 100)}% против ${pct.c}%)`);
    if (!verdicts.length) verdicts.push('по белкам-жирам-углеводам — как по плану');
  }
  return (
    <Sheet open={open} onClose={onClose} title={`${slot.emoji} ${slot.name}`}
      note={`${entries.length} поз. · ${fmt(t.kcal)} ккал · Б ${fmt(t.p)} · Ж ${fmt(t.f)} · У ${fmt(t.c)}`}>
      <div className="mb-3">
        {entries.map(e => (
          <SlotLine key={e.id} e={e} />
        ))}
      </div>
      <div className="text-[0.78125rem] mb-4" style={{ color: 'var(--mut)' }}>
            Сбалансированность: {verdicts.join('; ')}.
      </div>
      {entries.length === 0 && (
        <button className="dd-action" style={{ width: '100%', color: marked ? 'var(--mut)' : 'var(--warn)' }}
          onClick={() => toggleSlotMark(date, slot.id)}>
          {marked ? 'Снять отметку о пропуске' : 'Пометить как пропущенный'}
        </button>
      )}

      {entries.length > 0 && (
      <div className="dd-input-row items-end">
        <div className="flex-1 min-w-0">
          <input className="dd-input" value={name} onChange={e => setName(e.target.value)} placeholder="мой завтрак" />
        </div>
        <button className="dd-action strong" style={{ flex: 'none' }} disabled={saving || entries.length === 0}
          onClick={async () => { setSaving(true); await onSave(name.trim() || `мой ${slot.name.toLowerCase()}`); setSaving(false); }}>
          {saving ? 'Сохраняю…' : 'Сохранить приём'}
        </button>
      </div>
      )}
    </Sheet>
  );
}

function profile0(macroPct?: { p: number; f: number; c: number }) { return macroPct ?? { p: 25, f: 30, c: 45 }; }

function SlotLine({ e }: { e: Entry }) {
  const [name, setName] = useState('');
  const [isPc, setIsPc] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const f = e.kind === 'food' ? await db.foods.get(e.refId) : await db.recipes.get(e.refId);
      if (alive) { setName(f?.name ?? '—'); setIsPc(f?.unit === 'pc'); }
    })();
    return () => { alive = false; };
  }, [e]);
  return (
    <div className="flex justify-between items-baseline gap-2 text-[0.8125rem] py-1" style={{ borderBottom: '1px solid var(--tr)' }}>
      <span className="flex-1 min-w-0 truncate">{name}</span>
      <span className="flex-none" style={{ color: 'var(--mut)' }}>
        {isPc ? `${(Math.round((e.grams / 100) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} шт` : `${fmt(e.grams)} г`}
      </span>
      <span className="dd-num flex-none text-[0.875rem]" style={{ color: 'var(--tx)' }}>{fmt(e.snapshot.kcal)}</span>
    </div>
  );
}

/** Кольцо с сегментами Б/Ж/У: дуга делится по вкладу групп в съеденный калораж; оттенки одного цвета */
function MacroRing({ p, f, c, cap, children }: { p: number; f: number; c: number; cap: number; children: React.ReactNode }) {
  const size = 96, r = 43, sw = 10; // r как у Ring — одинаковый визуальный диаметр
  const circ = 2 * Math.PI * r;
  const total = Math.max(1, p + f + c);
  const fill = Math.min(100, cap > 0 ? (p + f + c) / cap * 100 : 0);
  const seg = (v: number) => (circ * fill / 100) * (v / total);
  const gap = 2;
  const parts: Array<[number, number]> = [[Math.max(0, seg(p) - gap), 1], [Math.max(0, seg(f) - gap), 0.62], [Math.max(0, seg(c) - gap), 0.36]];
  let acc = 0;
  const arcs = parts.map(([len, op]) => {
    const a = acc; acc += len + gap;
    return <circle key={op} cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--acc)" strokeWidth={sw}
      opacity={op} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-a} strokeLinecap="butt" />;
  });
  return (
    <div className="dd-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--tr)" strokeWidth={sw} />
        {arcs}
      </svg>
      <div className="dd-ring-val">{children}</div>
    </div>
  );
}

/** Кольцо цели (реформа v0.5.0): прогресс = тренд/план без обрезки; ×N для кратных перевыполнений */
function GoalRing({ goal, compact, onTap }: { goal: GoalProgress; compact?: boolean; onTap: () => void }) {
  const R = 43; const size = 96; const sw = 10;
  const color = goal.pct < 50 ? 'var(--warn)' : goal.pct < 80 ? 'var(--acc)' : 'var(--ok)';
  const circ = 2 * Math.PI * R;
  const fill = Math.min(100, goal.pct);
  const label = goal.pct >= 290 ? '×' + Math.floor(goal.pct / 100)
    : goal.pct >= 190 ? '×2'
    : goal.pct + '%';
  return (
    <button onClick={onTap} aria-label="Прогресс цели" className="dd-ring" style={{ width: size, height: size, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--tr)" strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke={color} strokeWidth={sw} strokeLinecap={goal.pct > 100 ? 'butt' : 'round'}
          strokeDasharray={`${circ * fill / 100} ${circ}`} />
      </svg>
      <div className="dd-ring-val">
        <div className="text-lg font-extrabold dd-num">{label}</div>
        {!compact && <div className="text-[0.625rem]" style={{ color: 'var(--mut)' }}>план</div>}
      </div>
    </button>
  );
}


async function dbSlots(): Promise<Slot[]> {
  const { db } = await import('./db');
  const s = await db.slots.filter(x => !x.deletedAt).toArray();
  return s.sort((a, b) => a.sortOrder - b.sortOrder);
}



function EntryLine({ e, slot, showTime, onClick }: { e: Entry; slot: Slot; showTime: 'snacks' | 'all'; onClick: () => void }) {
  const [name, setName] = useState<string>('');
  const [isPc, setIsPc] = useState(false);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      const f = e.kind === 'food' ? await db.foods.get(e.refId) : await db.recipes.get(e.refId);
      if (alive) { setName(f?.name ?? '—'); setIsPc(f?.unit === 'pc'); }
    })();
    return () => { alive = false; };
  }, [e]);
  const qtyLabel = isPc
    ? ` · ${(Math.round((e.grams / 100) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} шт`
    : ` · ${fmt(e.grams)} г`;
  const isSnack = slot.defaultTime === null;
  const showT = showTime === 'all' || isSnack;
  return (
    <div className="flex justify-between items-baseline gap-2 text-[0.84375rem] py-1 cursor-pointer" onClick={onClick}>
      <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--mut)' }}>
        {showT && <span className="dd-num" style={{ color: 'var(--acc-fg)' }}>{e.timeEaten} · </span>}
        {name}{qtyLabel}
      </span>
      <span className="dd-num flex-none text-[0.90625rem]" style={{ color: 'var(--tx)' }}>{fmt(e.snapshot.kcal)}</span>
    </div>
  );
}

function Calendar({ open, date, onClose, onPick, filled }: { open: boolean; date: string; onClose: () => void; onPick: (d: string) => void; filled: Set<string> }) {
  const [month, setMonth] = useState(() => { const d = fromISO(date); return new Date(d.getFullYear(), d.getMonth(), 1); });
  React.useEffect(() => { if (open) { const d = fromISO(date); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); } }, [open, date]);
  const grid = useMemo(() => {
    const first = new Date(month); first.setDate(1);
    const shift = (first.getDay() + 6) % 7; // Пн=0
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells: Array<string | null> = Array(shift).fill(null);
    for (let i = 1; i <= days; i++) {
      const dd = new Date(month.getFullYear(), month.getMonth(), i);
      cells.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
    }
    return cells;
  }, [month]);
  const t = todayISO();

  return (
    <Sheet open={open} onClose={onClose} title={`${MONTHS_NOM[month.getMonth()]} ${month.getFullYear()}`}>
      <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] mb-1" style={{ color: 'var(--mut)' }}>
        {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(w => <div key={w}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.map((iso, i) => iso ? (
          <button key={iso} className={cx('dd-cal-cell', iso === date && 'sel', iso === t && 'today')} onClick={() => onPick(iso)}>
            {parseInt(iso.slice(-2), 10)}
            {filled.has(iso) && <span className="dd-cal-dot" />}
          </button>
        ) : <div key={`e${i}`} />)}
      </div>
      <div className="flex justify-between mt-3">
        <button className="dd-link-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹ пред.</button>
        <button className="dd-link-btn" onClick={() => onPick(t)}>сегодня</button>
        <button className="dd-link-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>след. ›</button>
      </div>
    </Sheet>
  );
}

function EntryEditModal({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const [grams, setGrams] = useState('');
  const [time, setTime] = useState('');
  React.useEffect(() => {
    if (entry) { setGrams(String(Math.round(entry.grams))); setTime(entry.timeEaten); }
  }, [entry]);
  if (!entry) return null;
  const g = parseFloat(grams.replace(',', '.')) || 0;
  const ratio = g / Math.max(entry.grams, 0.01);
  return (
    <Sheet open={!!entry} onClose={onClose} title="Запись" note="Поправь вес или время — пересчитается автоматически.">
      <div className="dd-input-row">
        <div className="flex-1">
          <div className="dd-field-label" style={{ marginTop: 0 }}>Вес, г</div>
          <input className="dd-input dd-num" type="number" inputMode="decimal" value={grams} onChange={e => setGrams(e.target.value)} />
        </div>
        <div style={{ width: 120 }}>
          <div className="dd-field-label" style={{ marginTop: 0 }}>Время</div>
          <input className="dd-input dd-num" type="time" value={time} onChange={e => setTime(e.target.value)} />
        </div>
      </div>
      <div className="dd-card p-3 mt-3 text-center text-xs" style={{ color: 'var(--mut)' }}>
        станет: <b className="dd-num" style={{ color: 'var(--tx)' }}>{Math.round(entry.snapshot.kcal * ratio)} ккал</b>
      </div>
      <div className="flex gap-2 mt-4">
        <button className="dd-action" onClick={async () => { await deleteEntry(entry.id); track('entry_deleted'); onClose(); }}>Удалить</button>
        <button className="dd-action strong" onClick={async () => {
          const k = g / Math.max(entry.grams, 0.01);
          await saveEntry({ ...entry, grams: g, timeEaten: time, snapshot: {
            kcal: Math.round(entry.snapshot.kcal * k), p: Math.round(entry.snapshot.p * k * 10) / 10,
            f: Math.round(entry.snapshot.f * k * 10) / 10, c: Math.round(entry.snapshot.c * k * 10) / 10,
          } });
          track('entry_edited'); onClose();
        }}>Сохранить</button>
      </div>
    </Sheet>
  );
}
