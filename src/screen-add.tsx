// Экран добавления еды: sticky-поиск; секции «Из недавних»/«Найдено» при поиске;
// без поиска — Недавние/Проверенные вертикальными списками + единый «Все продукты»;
// свои продукты/рецепты: правка и удаление; ⚠️ и превышения — подсказки по тапу.
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Slot, type SavedMeal } from './db';
import { getCatalog, getRecent, toggleStar, saveCustomFood, saveRecipe, addEntry, applyMeal, deleteMeal, track, type CatalogItem } from './store';
import { nowHM, kbjuSuspicious, fmt, normE, guessCategory, lookupBarcode } from './lib';
import { Sheet, Modal, Confirm, Collapse, cx } from './ui';

interface AddScreenProps {
  date: string;
  slot: Slot | null;
  onDone: () => void;
}

export function AddScreen({ date, slot, onDone }: AddScreenProps) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<null | (Pick<EntryEditProps, 'item' | 'presetGrams' | 'presetTime'>)>(null);
  const [creatingFood, setCreatingFood] = useState(false);
  const [creatingRecipe, setCreatingRecipe] = useState(false);
  const [managing, setManaging] = useState<CatalogItem | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const [delMeal, setDelMeal] = useState<SavedMeal | null>(null);

  const catalog = useLiveQuery(() => getCatalog(q), [q], [] as CatalogItem[]);
  const recentKeys = useLiveQuery(() => getRecent(10), [], [] as Array<{ kind: 'food' | 'recipe'; refId: string }>);
  const meals = useLiveQuery(() => db.savedMeals.filter(m => !m.deletedAt).toArray(), [], [] as SavedMeal[]);
  const allSlots = useLiveQuery(() => db.slots.filter((s: Slot) => !s.deletedAt).sortBy('sortOrder'), [], [] as Slot[]);

  const searching = q.trim().length > 0;
  const ql = normE(q.trim());

  const { recentItems } = useMemo(() => {
    const map = new Map((catalog ?? []).map(i => [`${i.kind}:${i.id}`, i]));
    const rec = (recentKeys ?? []).map(k => map.get(`${k.kind}:${k.refId}`)).filter(Boolean) as CatalogItem[];
      return { recentItems: rec };
  }, [recentKeys, catalog]);

  // При поиске: недавние совпадения отдельно, остальная выдача — отдельно.
  // Дубли между секциями исключены: продукт из «Недавних» не повторяется в «Проверенных».
  const recentMatches = useMemo(
    () => (searching ? recentItems.filter(i => normE(i.name).includes(ql)).slice(0, 5) : []),
    [searching, recentItems, ql]);

  const searchRest = useMemo(() => {
    if (!searching) return [];
    const rm = new Set(recentMatches.map(i => `${i.kind}:${i.id}`));
    return (catalog ?? []).filter(i => !rm.has(`${i.kind}:${i.id}`));
  }, [searching, catalog, recentMatches]);

  // Сохранённые приёмы: показываем всегда (без поиска) или по совпадению имени
  const foodMap = useMemo(() => new Map((catalog ?? []).filter(i => i.kind === 'food').map(i => [i.id, i])), [catalog]);
  const mealKcal = (m: SavedMeal) => m.items.reduce((sum, it) => {
    const f = foodMap.get(it.foodId);
    return sum + (f ? f.per100.kcal * it.grams / 100 : 0);
  }, 0);
  const mealList = useMemo(
    () => (searching ? (meals ?? []).filter(m => normE(m.name).includes(ql)) : meals ?? []),
    [searching, meals, ql]);

  async function tapMeal(m: SavedMeal) {
    const target = slot ?? allSlots[0];
    if (!target) return;
    const n = await applyMeal(m.id, date, target);
    if (n) onDone();
  }

  // Единый список: свои и рецепты сверху, далее по алфавиту
  const allItems = useMemo(() => {
    const own = (catalog ?? []).filter(i => i.kind === 'recipe' || i.food.source !== 'system');
    const sys = (catalog ?? []).filter(i => i.kind === 'food' && i.food.source === 'system');
    sys.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return [...own, ...sys];
  }, [catalog]);

  function openItem(item: CatalogItem) {
    setEditing({ item, presetGrams: defaultGramsFor(item), presetTime: slot?.defaultTime ?? nowHM() });
  }

  return (
    <div className="min-h-screen pb-28">
      {/* Sticky: панель кнопок + поиск */}
      <div className="dd-addhead">
        <div className="flex items-center gap-1 px-4 pt-5">
          <button className="dd-arrow" onClick={onDone} aria-label="Назад">‹</button>
          <div className="flex-1" />
          <button className="dd-link-btn" onClick={() => setCreatingRecipe(true)}>+ рецепт</button>
          <button className="dd-link-btn" onClick={() => setCreatingFood(true)}>＋ продукт</button>
        </div>
        <div className="px-4 pt-1 dd-searchwrap">
          <input
            className="dd-input" placeholder={slot ? `Добавить в «${slot.name}»…` : 'Поиск: название или штрихкод…'}
            value={q} onChange={e => setQ(e.target.value)} style={q ? { paddingRight: 44 } : undefined}
          />
          {q && <button className="dd-searchclear" aria-label="Очистить поиск" onClick={() => setQ('')}>✕</button>}
        </div>
      </div>

      <div className="px-4">
        {mealList.length > 0 && (
          <Section title="🍽 Мои приёмы" id="meals" defaultOpen>
            {mealList.map(m => (
              <div key={m.id} className="dd-item" role="button" onClick={() => tapMeal(m)}>
                <div className="min-w-0 flex-1">
                  <div className="nm truncate">{m.name}</div>
                  <div className="sub">{m.items.length} поз. · ~{Math.round(mealKcal(m))} ккал — тап, чтобы внести</div>
                </div>
                <button className="dd-more" title="Удалить приём"
                  onClick={e => { e.stopPropagation(); setDelMeal(m); }}>⋯</button>
              </div>
            ))}
          </Section>
        )}
        {searching ? (
          <>
            {recentMatches.length > 0 && (
              <Section title="🕘 Из недавних" id="srch-recent" defaultOpen>
                {recentMatches.map(i => <ItemRow key={`rm-${i.kind}:${i.id}`} item={i} onOpen={() => openItem(i)} onStar={() => toggleStar(i)} onManage={setManaging} onWarn={() => setExplain('warn')} />)}
              </Section>
            )}
            <Section title="⌕ Найдено" id="srch-found" defaultOpen>
              {searchRest.length === 0 && recentMatches.length === 0 && (
                <p className="text-sm mt-4 text-center" style={{ color: 'var(--mut)' }}>
                  Ничего не нашлось. Создай свой продукт — кнопка「＋ продукт」
                </p>
              )}
              {searchRest.map(i => <ItemRow key={`s-${i.kind}:${i.id}`} item={i} onOpen={() => openItem(i)} onStar={() => toggleStar(i)} onManage={setManaging} onWarn={() => setExplain('warn')} />)}
            </Section>
          </>
        ) : (
          <>
            <div className="dd-allhead">Все продукты</div>
            {allItems.map(i => <ItemRow key={`a-${i.kind}:${i.id}`} item={i} onOpen={() => openItem(i)} onStar={() => toggleStar(i)} onManage={setManaging} onWarn={() => setExplain('warn')} />)}
          </>
        )}
      </div>

      <EntryEdit
        date={date} slot={slot} open={!!editing}
        item={editing?.item ?? null} presetGrams={editing?.presetGrams} presetTime={editing?.presetTime}
        onClose={() => setEditing(null)}
        onSaved={() => setQ('')}
      />
      <CreateFood open={creatingFood} initialName={q.trim()} onClose={() => setCreatingFood(false)} />
      <CreateRecipe open={creatingRecipe} onClose={() => setCreatingRecipe(false)} />
      <ManageItem item={managing} onClose={() => setManaging(null)} />

      <Confirm
        open={!!delMeal}
        text={`Удалить сохранённый приём «${delMeal?.name ?? ''}»? Записи в дневнике не тронутся.`}
        okLabel="Удалить" onCancel={() => setDelMeal(null)}
        onOk={() => { if (delMeal) deleteMeal(delMeal.id); setDelMeal(null); }}
      />

      <Modal open={!!explain} onClose={() => setExplain(null)}>
        <p className="dd-modal-text">
          {explain === 'warn'
            ? '⚠️ У этого продукта калории не сходятся с белками, жирами и углеводами — как если бы сумма деталей не равнялась целому. Такое бывает, когда в цифрах опечатка. Открой карточку и проверь, всё ли введено верно.'
            : explain ?? ''}
        </p>
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => setExplain(null)}>Понятно</button>
        </div>
      </Modal>
    </div>
  );
}

const collapseState: Record<string, boolean> = JSON.parse(localStorage.getItem('dd-collapse2') ?? '{}');
function persistCollapse() { localStorage.setItem('dd-collapse2', JSON.stringify(collapseState)); }

function Section({ title, id, defaultOpen, children }: { title: string; id: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(collapseState[id] ?? defaultOpen ?? true);
  return (
    <Collapse
      title={title}
      open={open}
      onToggle={() => { collapseState[id] = !open; persistCollapse(); setOpen(!open); }}
    >
      {children}
    </Collapse>
  );
}

function defaultGramsFor(i: CatalogItem): number {
  if (i.kind === 'food' && i.unit === 'pc') return 100; // 1 порция = 100 условных г
  return i.kind === 'food' ? (i.food.portionG ?? 100) : 150;
}

function ItemRow({ item, onOpen, onStar, onManage, onWarn }: {
  item: CatalogItem; onOpen: () => void; onStar: () => void;
  onManage: (i: CatalogItem) => void; onWarn: (w: string) => void;
}) {
  const perLabel = item.unit === 'pc' ? 'ккал/порц.' : 'ккал/100 г';
  const mine = item.kind === 'recipe' || item.food.source !== 'system';
  const brand = item.kind === 'food' ? (item.food as { brand?: string }).brand : undefined;
  return (
    <div className="dd-item" onClick={onOpen} role="button">
      <div className="min-w-0 flex-1">
        <div className="nm flex items-center gap-1.5">
          <span className="dd-star cursor-pointer" onClick={e => { e.stopPropagation(); onStar(); }}>{item.star ? '⭐' : '☆'}</span>
          <span className="truncate">{item.name}</span>
          {item.suspicious && <span className="dd-warnmark cursor-pointer" onClick={e => { e.stopPropagation(); onWarn('warn'); }}>⚠️</span>}
        </div>
        {brand && <div className="sub" style={{ marginTop: 1, color: 'var(--acc-fg)', opacity: .85 }}>{brand}</div>}
        <div className="sub">{item.kind === 'food' ? (item.food as { category?: string }).category ?? '' : 'Рецепты'} · {fmt(item.per100.kcal)} {perLabel}</div>
      </div>
      <div className="kc dd-num">{fmt(item.per100.p)}/{fmt(item.per100.f)}/{fmt(item.per100.c)}</div>
      {mine && <button className="dd-more" title="Изменить или удалить" onClick={e => { e.stopPropagation(); onManage(item); }}>⋯</button>}
    </div>
  );
}

// ── Карточка ввода: количество (г или порции) + время + сохранить ──
export interface EntryEditProps {
  date: string; slot: Slot | null; open: boolean;
  item: CatalogItem | null;
  presetGrams?: number; presetTime?: string;
  onClose: () => void;
  onSaved?: () => void;
}

function EntryEdit({ date, slot, open, item, presetGrams, presetTime, onClose, onSaved }: EntryEditProps) {
  const slots = useLiveQuery(() => db.slots.filter(s => !s.deletedAt).toArray(), [], [] as Slot[]);
  const [qty, setQty] = useState('');
  const [time, setTime] = useState('');
  const [slotId, setSlotId] = useState('');
  const [warn, setWarn] = useState(false);

  const isPc = item?.unit === 'pc';

  useEffect(() => {
    if (!open || !item) return;
    const g = presetGrams ?? defaultGramsFor(item);
    // порционные: граммы хранятся как шт × 100 — в поле показываем штуки
    setQty(isPc ? String(Math.round((g / 100) * 100) / 100) : String(Math.round(g)));
    setTime(presetTime ?? nowHM());
    setSlotId(slot && slot.id !== 'slot-snack' ? slot.id : '');
    setWarn(false);
  }, [open, item, presetGrams, presetTime, slot, isPc]);

  if (!item) return null;
  const n = parseFloat(qty.replace(',', '.')) || 0;
  const grams = isPc ? n * 100 : n;
  const k = grams / 100;
  const cur = slots.find(s => s.id === slotId) ?? slots.find(s => s.id === 'slot-snack') ?? slots[0];

  async function doSave(force = false) {
    if (!item || !cur || n <= 0) return;
    if (!force && kbjuSuspicious(item.per100.kcal, item.per100.p, item.per100.f, item.per100.c, item.name)) {
      setWarn(true); return;
    }
    await addEntry({ date, slot: cur, kind: item.kind, refId: item.id, grams, per100: item.per100, timeEaten: time });
    track('entry_added', { kind: item.kind, unit: item.unit, source: 'add-screen' });
    onSaved?.();
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={item.name}
      note={isPc
        ? `${fmt(item.per100.kcal)} ккал · Б ${fmt(item.per100.p)} · Ж ${fmt(item.per100.f)} · У ${fmt(item.per100.c)} на порцию`
        : `${fmt(item.per100.kcal)} ккал · Б ${fmt(item.per100.p)} · Ж ${fmt(item.per100.f)} · У ${fmt(item.per100.c)} на 100 г`}>
      <div className="dd-input-row">
        <div className="flex-1 min-w-0">
          <div className="dd-field-label" style={{ marginTop: 0 }}>{isPc ? 'Порций (шт)' : 'Вес порции, г'}</div>
          <input className="dd-input dd-num" type="number" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        <div className="min-w-0" style={{ width: 116 }}>
          <div className="dd-field-label" style={{ marginTop: 0 }}>Время</div>
          <input className="dd-input dd-num" type="time" value={time} onChange={e => setTime(e.target.value)} />
        </div>
      </div>

      <div className="dd-seg mt-3" style={{ display: 'flex' }}>
        {slots.sort((a, b) => a.sortOrder - b.sortOrder).filter(s => s.id !== 'slot-snack').map(s => (
          <button key={s.id} style={{ flex: 1 }} className={cx(s.id === slotId && 'on')} onClick={() => setSlotId(s.id)}>{s.emoji} {s.name}</button>
        ))}
      </div>

      <div className="mt-4 text-center" style={{ fontSize: 18, lineHeight: 1.35 }}>
        <b className="dd-num">{fmt(item.per100.kcal * k)} ккал</b>
        <span className="dd-num"> · Б {fmt(item.per100.p * k)} · Ж {fmt(item.per100.f * k)} · У {fmt(item.per100.c * k)}</span>
        <span style={{ color: 'var(--mut)' }}> на {isPc ? 'порцию' : 'порцию'}</span>
      </div>

      {warn && (
        <div className="dd-card p-3 mt-3 text-xs" style={{ color: 'var(--warn)' }}>
          ⚠️ КБЖУ выглядят непоследовательно (калории не сходятся с БЖУ). Проверь карточку — или сохрани как есть.
        </div>
      )}

      <div className="flex gap-2 mt-4">
        {warn
          ? <>
            <button className="dd-action" onClick={onClose}>Не сохранять</button>
            <button className="dd-action strong" onClick={() => doSave(true)}>Сохранить как есть</button>
          </>
          : <button className="dd-action strong" onClick={() => doSave()}>Сохранить</button>}
      </div>
    </Sheet>
  );
}

// ── Управление своим блюдом: правка продукта / удаление продукта или рецепта ──
function ManageItem({ item, onClose }: { item: CatalogItem | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [cat, setCat] = useState('');
  const [unit, setUnit] = useState<'g' | 'pc'>('g');
  const [kcal, setKcal] = useState(''); const [p, setP] = useState(''); const [f, setF] = useState(''); const [c, setC] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const cats = useLiveQuery(async () => [...new Set((await db.foods.toArray()).map(x => x.category))].sort(), [], [] as string[]);

  useEffect(() => {
    if (!item) return;
    setName(item.name);
    setCat(item.kind === 'food' ? item.food.category : '');
    if (item.kind === 'food') {
      setBrand(item.food.brand ?? '');
      setUnit(item.unit);
      setKcal(String(item.food.kcalPer100g)); setP(String(item.food.pPer100g));
      setF(String(item.food.fPer100g)); setC(String(item.food.cPer100g));
    }
    setConfirmDel(false);
  }, [item]);

  if (!item) return null;
  const nums = [kcal, p, f, c].map(x => parseFloat(x.replace(',', '.')) || 0);
  const calcK = Math.round(nums[1] * 4 + nums[2] * 9 + nums[3] * 4);
  const bjzuFull = p !== '' && f !== '' && c !== '';
  const valid = item.kind !== 'food' || (name.trim() !== '' && bjzuFull && kcal !== '' && parseFloat(kcal) > 0);
  const suspicious = item.kind === 'food' && bjzuFull && kcal !== '' && nums[1] + nums[2] + nums[3] > 0
    && kbjuSuspicious(parseFloat(kcal) || 0, nums[1], nums[2], nums[3], name);

  async function save() {
    if (!valid || item?.kind !== 'food') return;
    await db.foods.update(item.id, {
      name: name.trim(), brand: brand.trim() || undefined, category: cat || 'Свои продукты', unit,
      kcalPer100g: parseFloat(kcal) || 0, pPer100g: nums[1], fPer100g: nums[2], cPer100g: nums[3],
      updatedAt: Date.now(),
    });
    track('food_edited');
    onClose();
  }
  async function del() {
    if (!item) return;
    if (item.kind === 'food') await db.foods.update(item.id, { deletedAt: Date.now(), updatedAt: Date.now() });
    else await db.recipes.update(item.id, { deletedAt: Date.now(), updatedAt: Date.now() });
    track(item.kind === 'food' ? 'food_deleted' : 'recipe_deleted');
    onClose();
  }

  return (
    <Sheet open={!!item} onClose={onClose} title={item.kind === 'recipe' ? 'Рецепт' : 'Продукт'}
      note={item.kind === 'recipe' ? 'Рецепты пока можно только удалить (правка состава — в следующих версиях).' : undefined}>
      {item.kind === 'recipe' ? (
        <>
          <div className="dd-card p-4 text-center">
            <div className="text-[15px] font-semibold">{item.name}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--mut)' }}>{fmt(item.per100.kcal)} ккал/100 г готового</div>
          </div>
          <div className="flex gap-2 mt-4">
            <button className="dd-action" onClick={onClose}>Отмена</button>
            <button className="dd-action strong" style={{ color: 'var(--warn)' }} onClick={() => setConfirmDel(true)}>Удалить</button>
          </div>
        </>
      ) : (
        <>
          <input className="dd-input" placeholder="Название" value={name} onChange={e => setName(e.target.value)} />
          <div className="dd-field-label">Производитель</div>
          <input className="dd-input" placeholder="не указан" value={brand} onChange={e => setBrand(e.target.value)} />
          <div className="dd-field-label">Единица учёта</div>
          <div className="dd-seg">
            <button className={unit === 'g' ? 'on' : ''} onClick={() => setUnit('g')}>граммы</button>
            <button className={unit === 'pc' ? 'on' : ''} onClick={() => setUnit('pc')}>порции (шт)</button>
          </div>
          <div className="dd-field-label">КБЖУ {unit === 'pc' ? 'на 1 порцию' : 'на 100 г'}</div>
          <div className="dd-input-row">
            <NumCell label="Б" v={p} set={setP} />
            <NumCell label="Ж" v={f} set={setF} />
            <NumCell label="У" v={c} set={setC} />
            <NumCell label="ккал" v={kcal} set={setKcal} />
          </div>
          {suspicious
            ? <div className="text-[11px] mt-1" style={{ color: 'var(--warn)' }}>⚠️ калории ({fmt(parseFloat(kcal) || 0)}) не сходятся с БЖУ (расчёт {fmt(calcK)}) — блюдо будет с пометкой</div>
            : bjzuFull && <div className="text-[11px] mt-1" style={{ color: 'var(--mut)' }}>из БЖУ получается {fmt(calcK)} ккал — если введёшь другое, блюдо получит ⚠️</div>}
          <div className="dd-field-label">Категория</div>
          <select className="dd-input dd-select" value={cat} onChange={e => setCat(e.target.value)}>
            <option value="Свои продукты">Свои продукты</option>
            {(cats ?? []).map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <div className="flex gap-2 mt-4">
            <button className="dd-action" onClick={onClose}>Отмена</button>
            <button className="dd-action strong" disabled={!valid} onClick={save}>Сохранить</button>
          </div>
          <button className="dd-action mt-2" style={{ color: 'var(--warn)' }} onClick={() => setConfirmDel(true)}>Удалить продукт</button>
        </>
      )}
      <Confirm open={confirmDel} text={`Удалить «${item.name}» из каталога? Прошлые записи дневника останутся как есть.`}
        okLabel="Удалить" onCancel={() => setConfirmDel(false)} onOk={del} />
    </Sheet>
  );
}

// ── Создание своего продукта: БЖУ → калории (авто-режим), категория, EAN-13 ──
function CreateFood({ open, initialName, onClose }: { open: boolean; initialName: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [unit, setUnit] = useState<'g' | 'pc'>('g');
  const [kcal, setKcal] = useState(''); const [p, setP] = useState(''); const [f, setF] = useState(''); const [c, setC] = useState('');
  const [ean, setEan] = useState('');
  const [cat, setCat] = useState('Свои продукты');
  const [catTouched, setCatTouched] = useState(false);
  const [kcalTouched, setKcalTouched] = useState(false);
  type OffState = null | 'loading' | 'ok' | { error: string };
  const [offState, setOffState] = useState<OffState>(null);
  const cats = useLiveQuery(async () => [...new Set((await db.foods.toArray()).map(x => x.category))].sort(), [], [] as string[]);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    const g = guessCategory(initialName);
    setCat(g ?? 'Свои продукты'); setCatTouched(false);
    setKcalTouched(false); setOffState(null);
  }, [open, initialName]);

  const nums = [kcal, p, f, c].map(x => parseFloat(x.replace(',', '.')) || 0);
  const perLabel = unit === 'pc' ? 'на 1 порцию' : 'на 100 г';
  const bjzuFull = p !== '' && f !== '' && c !== '';
  const calcK = Math.round(nums[1] * 4 + nums[2] * 9 + nums[3] * 4);
  // авторасчёт: калории редактируемы, но предзаполнены расчётом, пока пользователь не ввёл свои
  useEffect(() => {
    if (bjzuFull && !kcalTouched) setKcal(String(calcK));
  }, [bjzuFull, kcalTouched, calcK]);
  const kcalFull = kcal !== '';
  const valid = name.trim() !== '' && bjzuFull && kcalFull && parseFloat(kcal) > 0
    && (ean === '' || /^\d{12,13}$/.test(ean));
  const suspicious = open && name && bjzuFull && kcalFull
    && kbjuSuspicious(parseFloat(kcal) || 0, nums[1], nums[2], nums[3], name);

  // автокатегория по названию, пока пользователь не выбрал сам
  useEffect(() => {
    if (catTouched || !name) return;
    const g = guessCategory(name);
    if (g) setCat(g);
  }, [name, catTouched]);

  async function lookup() {
    if (!/^\d{12,13}$/.test(ean)) return;
    setOffState('loading');
    const r = await lookupBarcode(ean);
    if ('error' in r) { setOffState({ error: r.error }); track('off_lookup', { ok: false }); return; }
    if (r.name) setName(r.name);
    if (r.brand) setBrand(r.brand);
    setP(String(r.p)); setF(String(r.f)); setC(String(r.c));
    setKcalTouched(false); // пусть предзаполнится авторасчётом
    setKcal(String(r.kcal));
    const g = guessCategory(r.name);
    if (g && !catTouched) setCat(g);
    setOffState('ok');
    track('off_lookup', { ok: true });
  }

  async function save() {
    if (!valid) return;
    await saveCustomFood({
      name: name.trim(), brand: brand.trim() || undefined, category: cat, unit,
      kcalPer100g: parseFloat(kcal) || 0, pPer100g: nums[1], fPer100g: nums[2], cPer100g: nums[3],
      barcode: ean || undefined,
    });
    onClose(); reset();
  }
  function reset() { setName(''); setBrand(''); setUnit('g'); setKcal(''); setP(''); setF(''); setC(''); setEan(''); setCat('Свои продукты'); setCatTouched(false); setKcalTouched(false); setOffState(null); }

  return (
    <Sheet open={open} onClose={() => { onClose(); reset(); }} title="Свой продукт"
      note="Сначала белки-жиры-углеводы — калории посчитаются сами (можно перебить). Учёт — в граммах или порциями.">
      <input className="dd-input" placeholder="Название (напр. Кофе латте)" value={name} onChange={e => setName(e.target.value)} />

      <div className="dd-field-label">Производитель (необязательно)</div>
      <input className="dd-input" placeholder="напр. Простоквашино" value={brand} onChange={e => setBrand(e.target.value)} />

      <div className="dd-field-label">Единица учёта</div>
      <div className="dd-seg">
        <button className={unit === 'g' ? 'on' : ''} onClick={() => setUnit('g')}>граммы</button>
        <button className={unit === 'pc' ? 'on' : ''} onClick={() => setUnit('pc')}>порции (шт)</button>
      </div>

      <div className="dd-field-label">КБЖУ {perLabel}</div>
      <div className="dd-input-row">
        <NumCell label="Б" v={p} set={setP} />
        <NumCell label="Ж" v={f} set={setF} />
        <NumCell label="У" v={c} set={setC} />
        <NumCell label="ккал" v={kcal} set={s => { setKcalTouched(true); setKcal(s); }} />
      </div>
      {!bjzuFull && <div className="text-[11px] mt-1" style={{ color: 'var(--mut)' }}>Заполни Б, Ж и У явно — нули тоже вводятся.</div>}
      {!kcalTouched && <div className="text-[11px] mt-1" style={{ color: 'var(--mut)' }}>калории рассчитаны из БЖУ — введёшь свои, появится пометка ⚠️ если не сойдётся</div>}

      <div className="dd-field-label">Категория{!catTouched && guessCategory(name) ? ' — подобрана по названию' : ''}</div>
      <select className="dd-input dd-select" value={cat} onChange={e => { setCatTouched(true); setCat(e.target.value); }}>
        <option value="Свои продукты">Свои продукты</option>
        {(cats ?? []).map(x => <option key={x} value={x}>{x}</option>)}
      </select>

      <div className="dd-field-label">Штрихкод EAN-13 — найти КБЖУ в открытой базе</div>
      <div className="dd-input-row">
        <input className="dd-input dd-num" type="text" inputMode="numeric" placeholder="напр. 4680036912345"
          value={ean} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 13); setEan(v); setOffState(null); }} />
        <button className="dd-action" style={{ flex: 'none', width: 92 }} disabled={!/^\d{12,13}$/.test(ean) || offState === 'loading'} onClick={lookup}>
          {offState === 'loading' ? '…' : '⤓ найти'}
        </button>
      </div>
      {offState === 'loading' && <div className="text-[11px] mt-1" style={{ color: 'var(--mut)' }}>ищу в Open Food Facts…</div>}
      {offState && offState !== 'loading' && offState !== 'ok' && 'error' in offState ? <div className="text-[11px] mt-1" style={{ color: 'var(--warn)' }}>{offState.error} — введу руками</div> : null}
      {offState === 'ok' && <div className="text-[11px] mt-1" style={{ color: 'var(--ok)' }}>нашёл — проверь и поправь при нужде</div>}

      {suspicious && <div className="dd-card p-3 mt-3 text-xs" style={{ color: 'var(--warn)' }}>⚠️ Калории не сходятся с БЖУ (расхождение &gt;25%). Проверь цифры — или сохрани, блюдо получит пометку ⚠️.</div>}
      <div className="flex gap-2 mt-4">
        <button className="dd-action" onClick={() => { onClose(); reset(); }}>Отмена</button>
        <button className="dd-action strong" disabled={!valid} onClick={save}>Сохранить</button>
      </div>
    </Sheet>
  );
}

function NumCell({ label, v, set, locked = false }: { label: string; v: string; set: (s: string) => void; locked?: boolean }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="dd-field-label" style={{ marginTop: 0 }}>{label}</div>
      <input className="dd-input dd-num" type="number" inputMode="decimal" value={v}
        readOnly={locked} onChange={e => set(e.target.value)} />
    </div>
  );
}

// ── Редактор рецепта ──
function CreateRecipe({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [items, setItems] = useState<Array<{ foodId: string; grams: number }>>([]);
  const [yieldG, setYield] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickQ, setPickQ] = useState('');
  const [err, setErr] = useState('');

  const foods = useLiveQuery(() => db.foods.filter(f => !f.deletedAt && f.source === 'system').toArray(), [], []);
  const picked = items.map(i => foods?.find(f => f.id === i.foodId)).filter(Boolean) as NonNullable<typeof foods>;
  const totalKcal = items.reduce((s, it, i) => s + (picked[i] ? picked[i].kcalPer100g * it.grams / 100 : 0), 0);

  async function save() {
    if (!name || items.length === 0 || !parseFloat(yieldG)) { setErr('Нужны название, хотя бы один ингредиент и выход готового веса'); return; }
    await saveRecipe(name, items, parseFloat(yieldG));
    onClose(); setName(''); setItems([]); setYield(''); setErr('');
  }

  const filtered = (foods ?? []).filter(f => !pickQ || f.name.toLowerCase().includes(pickQ.toLowerCase())).slice(0, 40);

  return (
    <Sheet open={open} onClose={onClose} title="Новый рецепт" note="Ингредиенты с граммовками + выход готового веса — КБЖУ посчитаются сами.">
      <input className="dd-input" placeholder="Название (напр. Сырники)" value={name} onChange={e => setName(e.target.value)} />
      <div className="dd-field-label">Ингредиенты</div>
      {items.map((it, i) => {
        const fd = picked[i];
        return (
          <div key={it.foodId} className="dd-item items-center" style={{ gap: 8 }}>
            <div className="flex-1 min-w-0">
              <div className="nm truncate">{fd?.name}</div>
            </div>
            <input className="dd-input dd-num" style={{ padding: '6px 8px', height: 34, width: 74, textAlign: 'center', flex: 'none' }} type="number" inputMode="numeric"
              value={it.grams}
              onChange={e => setItems(items.map((x, j) => j === i ? { ...x, grams: parseFloat(e.target.value) || 0 } : x))} />
            <span className="text-[11px]" style={{ color: 'var(--mut)', flex: 'none' }}>г</span>
            <button className="plus" onClick={() => setItems(items.filter((_, j) => j !== i))}>−</button>
          </div>
        );
      })}
      <button className="dd-action" onClick={() => setPicking(true)}>＋ Добавить ингредиент</button>

      <div className="dd-field-label">Выход готового веса, г (весь рецепт)</div>
      <input className="dd-input dd-num" type="number" inputMode="numeric" value={yieldG} onChange={e => setYield(e.target.value)} placeholder="напр. 520" />

      {items.length > 0 && parseFloat(yieldG) > 0 && (
        <div className="dd-card p-3 mt-3 text-center text-xs" style={{ color: 'var(--mut)' }}>
          Весь рецепт: <b style={{ color: 'var(--tx)' }} className="dd-num">{fmt(totalKcal)} ккал</b> ·
          на 100 г: <b style={{ color: 'var(--tx)' }} className="dd-num">{fmt(totalKcal / parseFloat(yieldG) * 100)} ккал</b>
        </div>
      )}
      {err && <div className="text-xs mt-2" style={{ color: 'var(--warn)' }}>{err}</div>}
      <div className="flex gap-2 mt-4">
        <button className="dd-action" onClick={onClose}>Отмена</button>
        <button className="dd-action strong" onClick={save}>Сохранить рецепт</button>
      </div>

      <Sheet open={picking} onClose={() => setPicking(false)} title="Ингредиент">
        <input className="dd-input mb-3" placeholder="Поиск продукта…" value={pickQ} onChange={e => setPickQ(e.target.value)} />
        {filtered.map(f => (
          <button key={f.id} className="dd-item" onClick={() => { setItems([...items, { foodId: f.id, grams: 100 }]); setPicking(false); setPickQ(''); }}>
            <div className="flex-1 min-w-0">
              <div className="nm truncate">{f.name}</div>
              <div className="sub">{f.category} · {fmt(f.kcalPer100g)} ккал/100 г</div>
            </div>
          </button>
        ))}
      </Sheet>
    </Sheet>
  );
}
