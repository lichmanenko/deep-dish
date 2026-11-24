// Настройки: внешний вид, время приёма пищи, данные, справка.
// Канон (v0.7.0): раздел = карточка с заголовком внутри; сегментные группы — равными долями по ширине.
import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Slot } from './db';
import { PALETTES, type DeviceSettings, todayISO } from './lib';
import { track } from './store';
import { exportJSON, exportCSV, download, wipeAll, importJSONText } from './data-transfer';
import { Segmented, Confirm, Modal, TopSheet } from './ui';
import { HelpSheet } from './help';

export function SettingsScreen({ settings, setSettings, onRestartOnboarding }: {
  settings: DeviceSettings; setSettings: (s: DeviceSettings) => void; onRestartOnboarding: () => void;
}) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [palOpen, setPalOpen] = useState(false);
  const curPal = () => PALETTES.find(p => p.key === settings.palette) ?? PALETTES[0];
  const palSw = (p: typeof PALETTES[number]) => {
    const darkNow = settings.theme !== 'auto' ? settings.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const c = darkNow ? p.dark : p.light;
    return `linear-gradient(135deg, ${c.acc}, ${c.acc2})`;
  };
  // импорт JSON (перенос каталога между устройствами)
  const fileJson = useRef<HTMLInputElement>(null);
  const importMode = useRef<'catalog' | 'archive'>('archive');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState(false);
  const [wipeBusy, setWipeBusy] = useState(false);

  function chooseImport(mode: 'catalog' | 'archive') {
    importMode.current = mode;
    fileJson.current?.click();
  }

  async function onJsonFile(f: File) {
    try {
      const counts = await importJSONText(await f.text(), importMode.current);
      const parts = Object.entries(counts).map(([k, v]) => `${v} ${k === 'entries' ? 'записей' : k === 'foods' ? 'продуктов' : k}`);
      setImportErr(false);
      setImportMsg(parts.length ? `Загружено: ${parts.join(', ')}.` : 'Нет записей для обновления.');
    } catch (e) { setImportErr(true); setImportMsg(`Импорт не удался: ${(e as Error).message}.`); }
  }

  const slots = useLiveQuery(async () =>
    (await db.slots.filter(s => !s.deletedAt).toArray()).sort((a, b) => a.sortOrder - b.sortOrder), [], [] as Slot[]);


  return (
    <div className="dd-screen">
      <h1 className="text-xl font-bold mb-4">Настройки</h1>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Внешний вид приложения</div>
        {/* гамма — выпадающий список: свернута в строку с текущей палитрой, выбор в доппанели (В., 24.10) */}
        <button className="w-full flex justify-between items-center text-left"
          style={{ minHeight: 46, paddingLeft: 13, paddingRight: 13, borderRadius: 12, background: 'var(--veil)' }}
          onClick={() => setPalOpen(true)}>
          <span className="text-sm" style={{ color: 'var(--tx)' }}>{curPal()?.name}</span>
          <span className="flex items-center gap-2" aria-hidden>
            <span style={{ width: 22, height: 22, borderRadius: 999, background: palSw(curPal()), boxShadow: '0 1px 4px rgba(0,0,0,.18)' }} />
            <span style={{ color: 'var(--mut)' }}>→</span>
          </span>
        </button>
        <div className="dd-field-label">Размер текста</div>
        <Segmented value={String(settings.textScale ?? 1)} onChange={v => setSettings({ ...settings, textScale: parseFloat(v) })} options={[
          { value: '1', label: 'обычный' }, { value: '1.15', label: 'крупный' }, { value: '1.3', label: 'очень крупный' },
        ]} />
        <div className="dd-field-label">Тема</div>
        <Segmented value={settings.theme} onChange={v => setSettings({ ...settings, theme: v })} options={[
          { value: 'auto', label: 'авто' }, { value: 'light', label: '☀️ светлая' }, { value: 'dark', label: '🌙 тёмная' },
        ]} />
      </div>

      
      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Время приёма пищи</div>
        {(slots ?? []).map(s => (
          <div key={s.id} className="flex justify-between items-center gap-2" style={{ minHeight: 54 }}>
            <div className="text-sm">{s.emoji} {s.name}</div>
            {s.defaultTime
              ? <div className="flex items-center gap-1">
                  <input type="time" aria-label={'Время · ' + s.name} className="dd-input dd-num" style={{ width: 110, padding: '8px 10px' }} value={s.defaultTime}
                    onChange={e => db.slots.update(s.id, { defaultTime: e.target.value, updatedAt: Date.now() })} />
                  <button className="dd-link-btn" title="Время будет подставляться в момент записи"
                    onClick={() => db.slots.update(s.id, { defaultTime: null, updatedAt: Date.now() })}>авто</button>
                </div>
              : <button className="dd-link-btn" onClick={() => db.slots.update(s.id, { defaultTime: '12:00', updatedAt: Date.now() })}>задать время</button>}
          </div>
        ))}
        <div className="dd-field-label">Показывать время у записей</div>
        <Segmented value={settings.showTime} onChange={v => setSettings({ ...settings, showTime: v })} options={[
          { value: 'snacks', label: 'только перекусы' }, { value: 'all', label: 'все записи' },
        ]} />
      </div>

      <div className="dd-card px-4 py-1 mb-4">
        <Row label="Как пользоваться" hint="короткая справка по экранам"
          action={<button className="dd-link-btn" aria-label="Открыть справку" onClick={() => setHelpOpen(true)}>→</button>} />
      </div>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Данные</div>
        <Row label="Экспорт архива JSON" hint="дневник, каталог, вес, профиль и нормы"
          action={<button className="dd-link-btn" aria-label="Скачать архив JSON" onClick={() => exportJSON().then(b => download(b, `deepdish-${todayISO()}.json`))}>→</button>} />
        <Row label="Экспорт дневника CSV" hint="записи еды для Excel"
          action={<button className="dd-link-btn" aria-label="Скачать дневник CSV" onClick={() => exportCSV().then(b => download(b, `deepdish-eda-${todayISO()}.csv`))}>→</button>} />
        <Row label="Импорт архива JSON" hint="объединяет архив с дневником, сохраняя более свежие записи"
          action={<button className="dd-link-btn" aria-label="Импортировать архив JSON" onClick={() => chooseImport('archive')}>→</button>} />
        <Row label="Импорт каталога JSON" hint="загружает продукты и рецепты"
          action={<button className="dd-link-btn" aria-label="Импортировать каталог JSON" onClick={() => chooseImport('catalog')}>→</button>} />
        <input ref={fileJson} type="file" accept=".json,application/json" hidden
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onJsonFile(f); }} />
        <Row label="Пройти онбординг заново" hint="как пользоваться + установка"
          action={<button className="dd-link-btn" aria-label="Пройти онбординг заново" onClick={onRestartOnboarding}>→</button>} />
        <Row label="Очистить дневник на устройстве" hint="удаляет локальный дневник и отключает семейный обмен"
          action={<button className="dd-link-btn" aria-label="Очистить дневник на устройстве" disabled={wipeBusy} style={{ color: 'var(--warn)' }} onClick={() => setConfirmWipe(true)}>→</button>} />
      </div>

      <p className="text-[0.625rem] mt-6 text-center" style={{ color: 'var(--mut)' }}>
        Deep Dish · v{__APP_VER__} · сборка {__APP_SHA__}
      </p>

      <TopSheet open={palOpen} onClose={() => setPalOpen(false)} title="Цветовая гамма">
        {PALETTES.map((p, i) => {
          const on = p.key === settings.palette;
          return (
            <button key={p.key} className="w-full flex justify-between items-center text-left"
              style={{ minHeight: 46, paddingLeft: 13, paddingRight: 13, borderRadius: 12, background: on ? 'var(--veil)' : 'transparent', ...(i ? { borderTop: '1px solid var(--tr)' } : {}) }}
              onClick={() => { setSettings({ ...settings, palette: p.key }); track('palette_changed', { to: p.key }); }}>
              <span className="text-sm" style={{ color: on ? 'var(--acc-fg)' : 'var(--tx)', fontWeight: on ? 700 : 500 }}>{p.name}</span>
              <span aria-hidden style={{ width: 22, height: 22, borderRadius: 999, background: palSw(p), boxShadow: '0 1px 4px rgba(0,0,0,.18)', flex: 'none' }} />
            </button>
          );
        })}
      </TopSheet>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />

      <Modal open={!!importMsg} onClose={() => { if (!importErr) location.reload(); else setImportMsg(null); }}>
        <p className="dd-modal-text">{importMsg}{!importErr && ' Экран перезагрузится.'}</p>
        <div className="dd-modal-row">
          <button className="dd-action strong" onClick={() => { if (!importErr) location.reload(); else setImportMsg(null); }}>Готово</button>
        </div>
      </Modal>

      <Confirm open={confirmWipe} text="Очистить дневник на этом устройстве? Записи, которые не успели синхронизироваться, можно сохранить заранее в архиве JSON. Данные на семейном сервере сохранятся."
        okLabel="Очистить устройство" onCancel={() => setConfirmWipe(false)}
        onOk={async () => {
          setConfirmWipe(false); setWipeBusy(true);
          try { await wipeAll(); location.reload(); }
          catch { setImportErr(true); setImportMsg('Не удалось очистить дневник. Попробуйте ещё раз.'); }
          finally { setWipeBusy(false); }
        }} />
    </div>
  );
}

function Row({ label, hint, action }: { label: string; hint?: string; action: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>{hint}</div>}
      </div>
      {action}
    </div>
  );
}
