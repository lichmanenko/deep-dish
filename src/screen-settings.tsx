// Настройки: гамма, тема, отображение времени, времена слотов, онбординг, экспорт/импорт, сброс
import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Slot } from './db';
import { PALETTES, type DeviceSettings, todayISO } from './lib';
import { loadFlags, saveFlags, detectDangerWindows, BASE_FLAG_CATS, type FlagSettings } from './banner';
import { exportJSON, exportCSV, download, wipeAll, track, importJSONText } from './store';
import { Segmented, Confirm, Modal, Toggle } from './ui';

export function SettingsScreen({ settings, setSettings, onRestartOnboarding }: {
  settings: DeviceSettings; setSettings: (s: DeviceSettings) => void; onRestartOnboarding: () => void;
}) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  // импорт JSON (перенос каталога между устройствами)
  const fileJson = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState(false);

  async function onJsonFile(f: File) {
    try {
      const counts = await importJSONText(await f.text());
      const parts = Object.entries(counts).map(([k, v]) => `${v} ${k === 'entries' ? 'записей' : k === 'foods' ? 'продуктов' : k}`);
      setImportErr(false);
      setImportMsg(`Загружено: ${parts.join(', ') || 'файл пуст'}.`);
    } catch (e) { setImportErr(true); setImportMsg(`Импорт не удался: ${(e as Error).message}.`); }
  }
  // мотивационные баннеры: тумблеры + красные флаг-категории
  const [flags, setFlags] = useState<FlagSettings>(() => loadFlags());
  const [flagsOpen, setFlagsOpen] = useState(false);
  const cats = useLiveQuery(async () => [...new Set((await db.foods.filter(f => !f.deletedAt).toArray()).map(f => f.category))].filter(c => c !== 'Импорт MFP').sort(), [], [] as string[]);
  const FLAG_CATS = [...BASE_FLAG_CATS, ...new Set((cats ?? []).filter(c => !BASE_FLAG_CATS.includes(c)))];
  const [dangerWins] = useState<Array<{ hour: number; count: number }>>([]);
  detectDangerWindows().then(w => { dangerWins.splice(0, dangerWins.length, ...w); });
  const slots = useLiveQuery(async () =>
    (await db.slots.filter(s => !s.deletedAt).toArray()).sort((a, b) => a.sortOrder - b.sortOrder), [], [] as Slot[]);


  return (
    <div className="min-h-screen px-4 pt-6 pb-28" style={{ overflowX: 'hidden' }}>
      <h1 className="text-xl font-bold mb-4">Настройки</h1>

      <div className="dd-field-label" style={{ marginTop: 0 }}>Цветовая гамма</div>
      <div className="dd-card p-4">
        <div className="dd-seg">
          {PALETTES.map(p => (
            <button key={p.key} className={p.key === settings.palette ? 'on' : ''} onClick={() => { setSettings({ ...settings, palette: p.key }); track('palette_changed', { to: p.key }); }}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="dd-field-label">Тема</div>
        <Segmented value={settings.theme} onChange={v => setSettings({ ...settings, theme: v })} options={[
          { value: 'auto', label: 'авто' }, { value: 'light', label: '☀️ светлая' }, { value: 'dark', label: '🌙 тёмная' },
        ]} />
        <div className="dd-field-label">Показывать время у записей</div>
        <Segmented value={settings.showTime} onChange={v => setSettings({ ...settings, showTime: v })} options={[
          { value: 'snacks', label: 'только перекусы' }, { value: 'all', label: 'все записи' },
        ]} />
      </div>

      <div className="dd-field-label">Мотивация</div>
      <div className="dd-card px-4 py-1">
        <div className="flex justify-between items-center py-3">
          <div className="text-sm">Баннеры <span style={{ color: 'var(--mut)' }}>— поддержка утром и осторожность перед «слабым» временем</span></div>
          <Toggle on={flags.praise || flags.warn} onChange={v => { const f = { ...flags, praise: v, warn: v }; setFlags(f); saveFlags(f); }} />
        </div>
        <div className="py-3">
          <button className="dd-link-btn" style={{ padding: '6px 0' }} onClick={() => setFlagsOpen(!flagsOpen)}>
            Красные флаги <span style={{ color: 'var(--mut)' }}>{flags.cats.length} категорий</span> {flagsOpen ? '▲' : '▼'}
          </button>
          {flagsOpen && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {FLAG_CATS.map(c => (
                <button key={c} className={flags.cats.includes(c) ? 'dd-cat-chip on' : 'dd-cat-chip'}
                  onClick={() => {
                    const cs = flags.cats.includes(c) ? flags.cats.filter(x => x !== c) : [...flags.cats, c];
                    const f = { ...flags, cats: cs }; setFlags(f); saveFlags(f);
                  }}>{c}</button>
              ))}
            </div>
          )}
          {dangerWins.length > 0 && (flags.praise || flags.warn) && (
            <div className="text-[11px] mt-2" style={{ color: 'var(--mut)' }}>
              найденные окна: {dangerWins.map(w => `${w.hour}:00 (${w.count}×)`).join(' · ')}
            </div>
          )}
        </div>
      </div>

      <div className="dd-field-label">Время приёма пищи</div>
      <div className="dd-card px-4 py-1">
        {(slots ?? []).map(s => (
          <div key={s.id} className="flex justify-between items-center py-3">
            <div className="text-sm">{s.emoji} {s.name}</div>
            {s.defaultTime
              ? <input type="time" className="dd-input dd-num" style={{ width: 110, padding: '8px 10px' }} value={s.defaultTime}
                  onChange={e => db.slots.update(s.id, { defaultTime: e.target.value, updatedAt: Date.now() })} />
              : <span className="text-xs" style={{ color: 'var(--mut)' }}>текущее время</span>}
          </div>
        ))}
      </div>

      <div className="dd-field-label">Данные</div>
      <div className="dd-card px-4 py-1">
        <Row label="Экспорт JSON (полный бэкап)" hint="все данные одной кнопкой"
          action={<button className="dd-link-btn" onClick={() => exportJSON().then(b => download(b, `deepdish-${todayISO()}.json`))}>→</button>} />
        <Row label="Экспорт CSV (еда)" hint="для Excel"
          action={<button className="dd-link-btn" onClick={() => exportCSV().then(b => download(b, `deepdish-eda-${todayISO()}.csv`))}>→</button>} />
        <Row label="Импорт JSON (перенос каталога)" hint="с другого устройства или от агента"
          action={<button className="dd-link-btn" onClick={() => fileJson.current?.click()}>→</button>} />
        <input ref={fileJson} type="file" accept=".json,application/json" hidden
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onJsonFile(f); }} />
        <Row label="Пройти онбординг заново" hint="как пользоваться + установка"
          action={<button className="dd-link-btn" onClick={onRestartOnboarding}>→</button>} />
        <Row label="Удалить все данные" hint="дневник, каталог, профиль — без возврата"
          action={<button className="dd-link-btn" style={{ color: 'var(--warn)' }} onClick={() => setConfirmWipe(true)}>→</button>} />
      </div>

      <p className="text-[10px] mt-6 text-center" style={{ color: 'var(--mut)' }}>
        Deep Dish · v{__APP_VER__} · сборка {__APP_SHA__} · работает офлайн · синхронизация в M2
      </p>

      <Modal open={!!importMsg} onClose={() => { if (!importErr) location.reload(); else setImportMsg(null); }}>
        <p className="dd-modal-text">{importMsg}{!importErr && ' Экран перезагрузится.'}</p>
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => { if (!importErr) location.reload(); else setImportMsg(null); }}>Готово</button>
        </div>
      </Modal>

      <Confirm open={confirmWipe} text="Точно удалить ВСЁ? Дневник, каталог и профиль исчезнут безвозвратно."
        okLabel="Удалить всё" onCancel={() => setConfirmWipe(false)}
        onOk={async () => { setConfirmWipe(false); await wipeAll(); location.reload(); }} />
    </div>
  );
}

function Row({ label, hint, action }: { label: string; hint?: string; action: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-[11px]" style={{ color: 'var(--mut)' }}>{hint}</div>}
      </div>
      {action}
    </div>
  );
}
