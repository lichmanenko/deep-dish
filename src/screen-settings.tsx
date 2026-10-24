// Настройки: внешний вид, время приёма пищи, данные, справка.
// Канон (v0.7.0): раздел = карточка с заголовком внутри; сегментные группы — равными долями по ширине.
import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Slot } from './db';
import { PALETTES, type DeviceSettings, todayISO } from './lib';
import { exportJSON, exportCSV, download, wipeAll, track, importJSONText } from './store';
import { Segmented, Confirm, Modal } from './ui';
import { HelpSheet } from './help';

export function SettingsScreen({ settings, setSettings, onRestartOnboarding }: {
  settings: DeviceSettings; setSettings: (s: DeviceSettings) => void; onRestartOnboarding: () => void;
}) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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

  const slots = useLiveQuery(async () =>
    (await db.slots.filter(s => !s.deletedAt).toArray()).sort((a, b) => a.sortOrder - b.sortOrder), [], [] as Slot[]);


  return (
    <div className="min-h-screen px-4 pt-6 pb-28" style={{ overflowX: 'hidden' }}>
      <h1 className="text-xl font-bold mb-4">Настройки</h1>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Внешний вид приложения</div>
        <div className="dd-field-label">Цветовая гамма</div>
        {/* палитры — списком строк со свотчем: имена в сегмент из 5 не влезают поровну (аудит v0.7.0) */}
        <div>
          {PALETTES.map((p, i) => {
            const darkNow = settings.theme !== 'auto' ? settings.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
            const c = darkNow ? p.dark : p.light;
            const on = p.key === settings.palette;
            return (
              <button key={p.key} className="w-full flex justify-between items-center text-left"
                style={{ minHeight: 46, paddingLeft: 2, paddingRight: 2, borderRadius: 12, background: on ? 'var(--veil)' : 'transparent', ...(i ? { borderTop: '1px solid var(--tr)' } : {}) }}
                onClick={() => { setSettings({ ...settings, palette: p.key }); track('palette_changed', { to: p.key }); }}>
                <span className="text-sm" style={{ color: on ? 'var(--acc-fg)' : 'var(--tx)', fontWeight: on ? 700 : 500 }}>{p.name}</span>
                <span aria-hidden style={{ width: 22, height: 22, borderRadius: 999, background: `linear-gradient(135deg, ${c.acc}, ${c.acc2})`, boxShadow: '0 1px 4px rgba(0,0,0,.18)', flex: 'none' }} />
              </button>
            );
          })}
        </div>
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
          <div key={s.id} className="flex justify-between items-center" style={{ minHeight: 54 }}>
            <div className="text-sm">{s.emoji} {s.name}</div>
            {s.defaultTime
              ? <input type="time" className="dd-input dd-num" style={{ width: 110, padding: '8px 10px' }} value={s.defaultTime}
                  onChange={e => db.slots.update(s.id, { defaultTime: e.target.value, updatedAt: Date.now() })} />
              : <span className="text-xs" style={{ color: 'var(--mut)' }}>в момент записи</span>}
          </div>
        ))}
        <div className="dd-field-label">Показывать время у записей</div>
        <Segmented value={settings.showTime} onChange={v => setSettings({ ...settings, showTime: v })} options={[
          { value: 'snacks', label: 'только перекусы' }, { value: 'all', label: 'все записи' },
        ]} />
      </div>

      <div className="dd-card px-4 py-1 mb-4">
        <Row label="Как пользоваться" hint="короткая справка по экранам"
          action={<button className="dd-link-btn" onClick={() => setHelpOpen(true)}>→</button>} />
      </div>

      <div className="dd-card p-4 mb-4">
        <div className="dd-field-label" style={{ marginTop: 0 }}>Данные</div>
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

      <p className="text-[0.625rem] mt-6 text-center" style={{ color: 'var(--mut)' }}>
        Deep Dish · v{__APP_VER__} · сборка {__APP_SHA__}
      </p>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />

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
        {hint && <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>{hint}</div>}
      </div>
      {action}
    </div>
  );
}
