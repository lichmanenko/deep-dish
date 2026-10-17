// Онбординг: знакомство → как вносить → профиль (опционально) → установка на «Домой»
// Компоновка: 100dvh без прокрутки страницы; шапка и кнопки закреплены, прокручивается только середина шага цели
import { useEffect, useState } from 'react';
import { saveProfile, getProfile, calcNorma, track } from './store';
import type { Profile } from './db';
import { Segmented } from './ui';
import { fmt } from './lib';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const next = () => { setStep(s => Math.min(s + 1, 3)); track('onboarding_step', { step }); };

  return (
    <div className="dd-onb">
      <div className="dd-onb-head">
        <div className="flex gap-2 justify-center py-2">
          {[0, 1, 2, 3].map(i => <span key={i} className="dd-dot" style={{ background: i === step ? 'var(--acc)' : 'var(--tr)' }} />)}
        </div>
      </div>

      <div className="dd-onb-body">
        {step === 0 && <Step emoji="🍽" title="Добро пожаловать в Deep Dish" text="Дневник питания и веса для всей семьи. Главный принцип — запись еды за пару секунд, всё остальное приложение берёт на себя." />}
        {step === 1 && <Step emoji="⚡️" title="Как вносить еду" text="Внизу — слоты приёмов пищи. «+» на карточке добавляет с последней порцией, вес поправится в той же карточке. Частое лежит в «Недавних», доверенное — отмечай ⭐." />}
        {step === 2 && <GoalStep onDone={next} skip={next} />}
        {step === 3 && <InstallStep onDone={onDone} />}
      </div>

      <div className="dd-onb-foot">
        {step < 2 && (
          <div className="flex gap-2">
            <button className="dd-action" onClick={onDone}>Пропустить</button>
            <button className="dd-action strong" onClick={next}>Далее</button>
          </div>
        )}
        <div className="text-center text-[0.625rem] pt-3" style={{ color: 'var(--mut)' }}>
          v{__APP_VER__} · {__APP_SHA__}
        </div>
      </div>
    </div>
  );
}

function Step({ emoji, title, text }: { emoji: string; title: string; text: string }) {
  return (
    <div className="text-center pt-6">
      <div className="text-[3.25rem] mb-5">{emoji}</div>
      <h2 className="text-[1.4375rem] font-bold tracking-tight">{title}</h2>
      <p className="text-sm mt-3 leading-relaxed px-2" style={{ color: 'var(--mut)' }}>{text}</p>
    </div>
  );
}

/** Числовое поле со строковым состоянием: очистка не рождает «0», ввод не даёт «039». */
export function NumField({ label, value, onChange, unit }: {
  label: string; value: number | undefined; onChange: (n: number | undefined) => void; unit?: string;
}) {
  const [s, setS] = useState(value === undefined ? '' : String(value));
  return (
    <div className="flex-1 min-w-0">
      <div className="dd-field-label" style={{ marginTop: 0 }}>{label}</div>
      <input
        className="dd-input dd-num" type="number" inputMode="numeric" value={s}
        onChange={e => {
          setS(e.target.value);
          const n = parseFloat(e.target.value.replace(',', '.'));
          onChange(e.target.value.trim() === '' || Number.isNaN(n) ? undefined : n);
        }}
      />
      {unit && <div className="text-[0.625rem] mt-1" style={{ color: 'var(--mut)' }}>{unit}</div>}
    </div>
  );
}

function GoalStep({ onDone, skip }: { onDone: () => void; skip: () => void }) {
  const [pr, setPr] = useState<Profile | null>(null);
  useEffect(() => {
    getProfile().then(p => setPr(p ?? {
      userId: 'local', gender: 'male', age: 35, heightCm: 175, formula: 'mifflin',
      activity: 'light', goal: 'none', paceKgPerWeek: 0.5, updatedAt: 0,
    }));
  }, []);
  if (!pr) return <div />;
  const set = (patch: Partial<Profile>) => setPr({ ...pr, ...patch });
  const norma = calcNorma(pr);

  return (
    <div>
      <div className="text-center mb-3 pt-2">
        <div className="text-[2.375rem]">🎯</div>
        <h2 className="text-[1.3125rem] font-bold">Цель — по желанию</h2>
      </div>
      <div className="dd-card p-4">
        <div className="text-[0.75rem] font-semibold mb-2" style={{ color: 'var(--mut)' }}>О СЕБЕ</div>
        <div className="dd-input-row">
          <NumField label="возраст" value={pr.age} onChange={n => set({ age: n ?? 0 })} />
          <NumField label="рост, см" value={pr.heightCm} onChange={n => set({ heightCm: n ?? 0 })} />
          <NumField label="вес, кг" value={pr.weightKg} onChange={n => set({ weightKg: n })} />
        </div>

        <div className="text-[0.75rem] font-semibold mt-3 mb-2" style={{ color: 'var(--mut)' }}>ЦЕЛЬ</div>
        <Segmented value={pr.goal} onChange={v => set({ goal: v })} options={[
          { value: 'none', label: 'без цели' }, { value: 'lose', label: 'худеть' },
          { value: 'maintain', label: 'держать' }, { value: 'gain', label: 'набирать' },
        ]} />
        {pr.goal !== 'none' && <>
          <div className="dd-field-label">Темп</div>
          <Segmented value={String(pr.paceKgPerWeek)} onChange={v => set({ paceKgPerWeek: parseFloat(v) })} options={[
            { value: '0.25', label: '0,25 кг/нед' }, { value: '0.5', label: '0,5' }, { value: '1', label: '1,0' },
          ]} />
          <div className="text-[0.6875rem] mt-2 text-center" style={{ color: 'var(--mut)' }}>цель — темп изменения веса; конкретный вес не фиксируем</div>
        </>}

        {norma ? (
          <div className="dd-card p-3 mt-3 text-center" style={{ background: 'var(--veil)' }}>
            <div className="dd-num" style={{ color: 'var(--acc-fg)', fontWeight: 800, fontSize: 20 }}>{fmt(norma.kcal)} ккал</div>
            <div className="text-[0.6875rem] mt-1 dd-num" style={{ color: 'var(--mut)' }}>
              расход ≈ {norma.tdee}{norma.adj !== 0 ? ` → ${norma.adj > 0 ? '+' : ''}${norma.adj} по темпу` : ' · без поправки'}
            </div>
          </div>
        ) : (
          <div className="text-[0.6875rem] mt-3 text-center" style={{ color: 'var(--mut)' }}>укажи текущий вес — посчитается норма</div>
        )}
      </div>
      <div className="flex gap-2 mt-3">
        <button className="dd-action" onClick={skip}>Позже</button>
        <button className="dd-action strong" onClick={async () => { await saveProfile(pr); track('profile_saved', { from: 'onboarding' }); onDone(); }}>Готово</button>
      </div>
    </div>
  );
}

function InstallStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="text-center pt-4">
      <div className="text-[3.25rem] mb-4">📲</div>
      <h2 className="text-[1.375rem] font-bold tracking-tight">Добавь на экран «Домой»</h2>
      <div className="dd-card p-4 mt-4 text-left text-[0.8125rem] leading-relaxed" style={{ color: 'var(--mut)' }}>
        <div className="mb-2"><b style={{ color: 'var(--tx)' }}>1.</b> Нажми «Поделиться» <span className="dd-num">(квадрат со стрелкой)</span> внизу Safari</div>
        <div className="mb-2"><b style={{ color: 'var(--tx)' }}>2.</b> «На экран Домой» → «Добавить»</div>
        <div><b style={{ color: 'var(--tx)' }}>3.</b> Готово — приложение работает без интернета, иконка как у «родных»</div>
      </div>
      <p className="text-xs mt-3" style={{ color: 'var(--mut)' }}>Установка также защищает данные от чистки кэша Safari.</p>
      <button className="dd-action strong mt-4" onClick={onDone}>Начать пользоваться</button>
    </div>
  );
}
