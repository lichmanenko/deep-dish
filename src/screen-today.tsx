// Экран «Сегодня»: кольцо нормы, чипы БЖУ, слоты с записями, навигация по датам
import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Entry, type Slot } from './db';
import type { DayNorma } from './db';
import { getEntries, getProfile, saveProfile, deleteEntry, saveEntry, track, saveMealFromSlot, ensureDayNorma, goalProgress, type GoalProgress } from './store';
import { shiftISO, todayISO, humanDate, fromISO, MONTHS_NOM, fmt } from './lib';
import { Ring, Sheet, useSwipe, Slide, Confirm, cx, Modal } from './ui';

export function TodayScreen({ date, setDate, onAdd, showTime }: {
  date: string; setDate: (d: string) => void; onAdd: (slot: Slot | null) => void; showTime: 'snacks' | 'all';
}) {
  const entries = useLiveQuery(() => getEntries(date), [date], [] as Entry[]);
  const slots = useLiveQuery(() => dbSlots(), [], [] as Slot[]);
  const profile = useLiveQuery(() => getProfile(), []);
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
  const [editEntry, setEditEntry] = useState<Entry | null>(null);
  const [confirmDel, setConfirmDel] = useState<Entry | null>(null);
  const [explain, setExplain] = useState<null | { title: string; text: string }>(null);
  const [goalInfo, setGoalInfo] = useState(false);
  const goal = useLiveQuery(() => goalProgress(), [], null);
  // фиксация целевой даты — записью нельзя внутри liveQuery, делаем после
  useEffect(() => {
    if (goal && !goal.dateFixed) {
      getProfile().then(pr => { if (pr && !pr.goalDateIso) saveProfile({ ...pr, goalDateIso: goal.goalDate }); });
    }
  }, [goal?.dateFixed, goal?.goalDate]);

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
            <div className="text-[18px] font-bold tracking-tight leading-tight">{humanDate(date)}</div>
          </button>
          <button className="dd-arrow" onClick={() => { setDate(shiftISO(date, 1)); setDir(-1); }} aria-label="Следующий день">›</button>
        </div>
        <div className="flex items-center gap-1.5" style={{ color: 'var(--acc-fg)' }}>
          <svg width="20" height="20" viewBox="0 0 96 96" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="48" cy="48" r="38" fill="none" stroke="var(--tr)" strokeWidth="12" />
            <circle cx="48" cy="48" r="38" fill="none" stroke="var(--acc)" strokeWidth="12" strokeLinecap="round" strokeDasharray="172 239" />
          </svg>
          <span className="text-[18px] font-bold tracking-tight" style={{ color: 'var(--tx)' }}>deep dish</span>
        </div>
      </div>

      <Slide dir={dir}>
        {!norma && (
          <div className="dd-card p-3 mb-3 text-xs text-center" style={{ color: 'var(--mut)' }}>
            Заполни профиль — появится дневная норма и кольцо. <b style={{ color: 'var(--acc-fg)' }}>Профиль →</b>
          </div>
        )}
        <div className="dd-card p-5 mb-3">
          <div className="grid grid-cols-3 items-center">
            <div className="flex justify-center">
              <button aria-label="Переключить кольцо" onClick={toggleRingMode} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                {ringMode === 'kcal' ? (
                  <Ring percent={percent}>
                    <div className="text-lg font-extrabold dd-num">{fmt(rest)}</div>
                    <div className="text-[10px]" style={{ color: 'var(--mut)' }}>осталось</div>
                  </Ring>
                ) : (
                  <MacroRing p={totals.p * 4} f={totals.f * 9} c={totals.c * 4} cap={target}>
                    <div className="text-lg font-extrabold dd-num">{fmt(rest)}</div>
                    <div className="text-[10px]" style={{ color: 'var(--mut)' }}>осталось</div>
                  </MacroRing>
                )}
              </button>
            </div>
            <div className="text-center px-1">
              <div className="text-xl font-bold dd-num">{fmt(totals.kcal)} ккал</div>
              <div className="text-xs mt-1" style={{ color: 'var(--mut)' }}>из {target} · {percent}%</div>
              {percent > 100 && <div className="text-xs mt-1" style={{ color: 'var(--warn)' }}>↑ перебор на {fmt(totals.kcal - target)}</div>}
            </div>
            <div className="flex justify-center">
              {goal && <GoalRing goal={goal} onTap={() => setGoalInfo(true)} />}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <MacroChip v={totals.p} goal={norma?.p} k="белки" onClick={() => setExplain({
            title: 'Белки',
            text: norma
              ? `Белков сегодня — ${fmt(totals.p)} г, а цель на день — ${fmt(norma.p)} г. ${totals.p > norma.p ? 'Это немного больше плана: не страшно, просто информация.' : 'Укладываешься в план.'}`
              : 'Заполни профиль — появятся цели по белкам, жирам и углеводам.',
          })} />
          <MacroChip v={totals.f} goal={norma?.f} k="жиры" onClick={() => setExplain({
            title: 'Жиры',
            text: norma
              ? `Жиров сегодня — ${fmt(totals.f)} г, а цель на день — ${fmt(norma.f)} г. ${totals.f > norma.f ? 'Это немного больше плана: не страшно, просто информация.' : 'Укладываешься в план.'}`
              : 'Заполни профиль — появятся цели по белкам, жирам и углеводам.',
          })} />
          <MacroChip v={totals.c} goal={norma?.c} k="углев." onClick={() => setExplain({
            title: 'Углеводы',
            text: norma
              ? `Углеводов сегодня — ${fmt(totals.c)} г, а цель на день — ${fmt(norma.c)} г. ${totals.c > norma.c ? 'Это немного больше плана: не страшно, просто информация.' : 'Укладываешься в план.'}`
              : 'Заполни профиль — появятся цели по белкам, жирам и углеводам.',
          })} />
        </div>

        {(slots ?? []).map(slot => {
          const es = entries.filter(e => e.slotId === slot.id);
          const sum = es.reduce((s, e) => s + e.snapshot.kcal, 0);
          return (
            <div key={slot.id} className="dd-card px-4 pt-4 pb-3 mb-2.5" onClick={() => es.length === 0 && onAdd(slot)}>
              <div className="flex justify-between items-baseline mb-1">
                <button className="text-[15px] font-semibold flex items-baseline gap-2 dd-slot-link"
                  onClick={e => { e.stopPropagation(); setSlotInfo(slot); }}>
                  <span>{slot.emoji}</span>{slot.name}
                </button>
                <div className="text-xs dd-num flex items-center" style={{ color: 'var(--mut)' }}>
                  {es.length
                    ? <span className="dd-num font-bold" style={{ fontSize: 13.5, color: 'var(--tx)' }}>{fmt(sum)} ккал</span>
                    : 'ничего'}
                </div>
              </div>
              {es.map(e => (
                <EntryLine key={e.id} e={e} slot={slot} showTime={showTime} onClick={() => setEditEntry(e)} />
              ))}
              <div className="dd-slot-add" onClick={() => onAdd(slot)}>＋ добавить</div>
            </div>
          );
        })}

        <button className="dd-action mt-2" onClick={() => onAdd(null)}>＋ Добавить еду</button>
      </Slide>

      <Calendar open={calOpen} date={date} onClose={() => setCalOpen(false)} onPick={d => { setDate(d); setCalOpen(false); }} filled={filledDays} />

      <EntryEditModal entry={editEntry} onClose={() => setEditEntry(null)} />
      <Modal open={!!explain} onClose={() => setExplain(null)}>
        <div className="text-[15px] font-bold mb-2">{explain?.title}</div>
        <p className="dd-modal-text">{explain?.text}</p>
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => setExplain(null)}>Понятно</button>
        </div>
      </Modal>


      <SlotInfoSheet
        open={!!slotInfo} slot={slotInfo} date={date}
        entries={(slotInfo ? entries.filter(e => e.slotId === slotInfo.id) : [])}
        macroPct={profile?.macroPct}
        onClose={() => setSlotInfo(null)}
        onSave={async name => { if (slotInfo) { await saveMealFromSlot(name, slotInfo.id, date); setSlotInfo(null); } }}
      />

      <Modal open={goalInfo} onClose={() => setGoalInfo(false)}>
        <div className="text-[15px] font-bold mb-2">Выполнение цели</div>
        {(() => {
          if (!goal) return <p className="dd-modal-text">Задай цель по весу в профиле — здесь появится прогноз её выполнения.</p>;
          const rows: Array<[string, string]> = [
            ['Текущий вес', `${String(goal.startKg).replace('.', ',')} кг`],
            ['Цель', `${String(goal.goalKg).replace('.', ',')} кг к ${ruDate(goal.goalDate)}`],
            ['Прогноз к этой дате', `${String(goal.forecastKg).replace('.', ',')} кг (по тренду ${goal.slopePerWeek > 0 ? '−' : '+'}${String(Math.abs(goal.slopePerWeek)).replace('.', ',')} кг/нед)`],
            ['Выполнение', `${goal.pct}% — насколько к целевой дате закроется разрыв между текущим и целевым весом`],
          ];
          return (
            <>
              {rows.map(([k, v]) => (
                <div key={k} className="py-1.5" style={{ borderBottom: '1px solid var(--tr)' }}>
                  <div className="text-[11px]" style={{ color: 'var(--mut)' }}>{k}</div>
                  <div className="text-[13px]">{v}</div>
                </div>
              ))}
              <p className="dd-modal-text" style={{ marginTop: 8 }}>
                Как считаем: тренд — усреднённая прямая по взвешиваниям за 8 недель (не реагирует на воду и соль).
                Прогнозный вес — продолжение тренда до целевой даты. Выполнение = (текущий − прогноз) / (текущий − цель), но не меньше 0.
                Цвет кольца: ниже 50% — тревожный, 50–80% — нейтральный, выше 80% — позитивный.
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
function SlotInfoSheet({ open, slot, entries, macroPct, onClose, onSave }: {
  open: boolean; slot: Slot | null; entries: Entry[]; date: string;
  macroPct?: { p: number; f: number; c: number };
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
      <div className="text-[12.5px] mb-4" style={{ color: 'var(--mut)' }}>
            Сбалансированность: {verdicts.join('; ')}.
      </div>
      <div className="dd-input-row items-end">
        <div className="flex-1 min-w-0">
          <input className="dd-input" value={name} onChange={e => setName(e.target.value)} placeholder="мой завтрак" />
        </div>
        <button className="dd-action strong" style={{ flex: 'none' }} disabled={saving || entries.length === 0}
          onClick={async () => { setSaving(true); await onSave(name.trim() || `мой ${slot.name.toLowerCase()}`); setSaving(false); }}>
          {saving ? 'Сохраняю…' : 'Сохранить приём'}
        </button>
      </div>
    </Sheet>
  );
}

function profile0(macroPct?: { p: number; f: number; c: number }) { return macroPct ?? { p: 25, f: 30, c: 45 }; }

function SlotLine({ e }: { e: Entry }) {
  const [name, setName] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => { const f = e.kind === 'food' ? await db.foods.get(e.refId) : await db.recipes.get(e.refId); if (alive) setName(f?.name ?? '—'); })();
    return () => { alive = false; };
  }, [e]);
  return (
    <div className="flex justify-between items-baseline text-[13px] py-1" style={{ borderBottom: '1px solid var(--tr)' }}>
      <span>{name}<span style={{ color: 'var(--mut)' }}> · {fmt(e.grams)} г</span></span>
      <span className="dd-num text-[11.5px]" style={{ color: 'var(--mut)' }}>{fmt(e.snapshot.kcal)}</span>
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

/** Кольцо цели (формула В.): выполнение = прогнозная разница / целевая разница; светофор по гамме */
function GoalRing({ goal, onTap }: { goal: GoalProgress; onTap: () => void }) {
  const R = 39; const size = 96; const sw = 10;
  const color = goal.pct < 50 ? 'var(--warn)' : goal.pct < 80 ? 'var(--acc)' : 'var(--ok)';
  const circ = 2 * Math.PI * R;
  return (
    <button onClick={onTap} aria-label="Выполнение цели" className="dd-ring" style={{ width: size, height: size, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--tr)" strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={`${circ * goal.pct / 100} ${circ}`} />
      </svg>
      <div className="dd-ring-val">
        <div className="text-lg font-extrabold dd-num">{goal.pct}%</div>
        <div className="text-[10px]" style={{ color: 'var(--mut)' }}>цель</div>
      </div>
    </button>
  );
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function ruDate(iso: string) { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`; }

async function dbSlots(): Promise<Slot[]> {
  const { db } = await import('./db');
  const s = await db.slots.filter(x => !x.deletedAt).toArray();
  return s.sort((a, b) => a.sortOrder - b.sortOrder);
}

function MacroChip({ v, goal, k, onClick }: { v: number; goal?: number; k: string; onClick: () => void }) {
  const over = goal !== undefined && v > goal;
  return (
    <div className="dd-card flex-1 text-center py-2.5 cursor-pointer" onClick={onClick}>
      <div className="text-[15px] font-bold dd-num flex items-center justify-center gap-1" style={over ? { color: 'var(--warn)' } : undefined}>
        {fmt(v)} г{over && <span className="text-[11px]">▲</span>}
      </div>
      <div className="text-[11px]" style={{ color: 'var(--mut)' }}>{k}{goal !== undefined ? ` · ${fmt(goal)}` : ''}</div>
    </div>
  );
}


function EntryLine({ e, slot, showTime, onClick }: { e: Entry; slot: Slot; showTime: 'snacks' | 'all'; onClick: () => void }) {
  const [name, setName] = useState<string>('');
  const [isPc, setIsPc] = useState(false);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      const f = e.kind === 'food' ? await db.foods.get(e.refId) : await db.recipes.get(e.refId);
      if (alive) { setName(f?.name ?? '—'); setIsPc(e.kind === 'food' && (f as import('./db').Food | undefined)?.unit === 'pc'); }
    })();
    return () => { alive = false; };
  }, [e]);
  const qtyLabel = isPc
    ? ` · ${(Math.round((e.grams / 100) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} шт`
    : ` · ${fmt(e.grams)} г`;
  const isSnack = slot.defaultTime === null;
  const showT = showTime === 'all' || isSnack;
  return (
    <div className="flex justify-between items-baseline text-[13.5px] py-1 cursor-pointer" onClick={onClick}>
      <span style={{ color: 'var(--mut)' }}>
        {showT && <span className="dd-num" style={{ color: 'var(--acc-fg)' }}>{e.timeEaten} · </span>}
        {name}{qtyLabel}
      </span>
      <span className="dd-num text-[11.5px]" style={{ color: 'var(--mut)' }}>{fmt(e.snapshot.kcal)}</span>
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
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] mb-1" style={{ color: 'var(--mut)' }}>
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
