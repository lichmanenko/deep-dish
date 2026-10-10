// Настройки: гамма, тема, отображение времени, времена слотов, онбординг, экспорт/импорт, сброс
import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Slot } from './db';
import { PALETTES, type DeviceSettings, todayISO } from './lib';
import { loadFlags, saveFlags, detectDangerWindows, BASE_FLAG_CATS, type FlagSettings } from './banner';
import { loadSync, saveSync, registerDevice, runSync, syncStatusText, type SyncSettings } from './sync';
import { fetchMetrics, type MetricsData } from './metrics';
import { exportJSON, exportCSV, download, wipeAll, track, importJSONText } from './store';
import { Segmented, Confirm, Modal, Toggle, Sheet } from './ui';

export function SettingsScreen({ settings, setSettings, onRestartOnboarding }: {
  settings: DeviceSettings; setSettings: (s: DeviceSettings) => void; onRestartOnboarding: () => void;
}) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  // Синхронизация (M2)
  const [sync, setSync] = useState<SyncSettings | null>(() => loadSync());
  const [srvAddr, setSrvAddr] = useState('');
  const [nick, setNick] = useState('');
  const [adminTok, setAdminTok] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [metricsErr, setMetricsErr] = useState<string | null>(null);

  async function doMetrics() {
    setMetrics(null); setMetricsErr(null);
    try { setMetrics(await fetchMetrics(30)); track('metrics_open'); }
    catch (e) { setMetricsErr((e as Error).message); }
  }

  async function doRegister() {
    if (syncBusy) return;
    setSyncBusy(true); setSyncMsg(null);
    try {
      const srv = srvAddr.trim().replace(/\/$/, '');
      const st = await registerDevice(srv, nick.trim() || 'я', adminTok.trim() || undefined);
      saveSync(st); setSync(st);
      setSyncMsg(`Подключено: ${st.nickname} (${st.role}). Теперь «Синхронизировать».`);
    } catch (e) { setSyncMsg(`Не получилось: ${(e as Error).message}`); }
    setSyncBusy(false);
  }

  async function doSync() {
    if (syncBusy) return;
    setSyncBusy(true); setSyncMsg(null);
    try {
      const r = await runSync();
      setSyncMsg(r.ok ? `Синк прошёл: отправлено ${r.pushed}, получено ${r.pulled}.` : `Синк не удался: ${r.error}`);
      setSync(loadSync());
      track('sync_manual', { pushed: r.pushed, pulled: r.pulled });
    } catch (e) { setSyncMsg(`Синк не удался: ${(e as Error).message}`); }
    setSyncBusy(false);
  }
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

      <div className="dd-field-label">Синхронизация</div>
      <div className="dd-card px-4 py-1">
        {sync ? (
          <>
            <div className="py-3">
              <div className="text-sm">{syncStatusText()}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--mut)', wordBreak: 'break-all' }}>{sync.server}</div>
              {sync.role === 'admin' && (
                <button className="dd-link-btn mt-1" style={{ padding: '6px 0', fontSize: 12 }}
                  title="Нажми, чтобы скопировать"
                  onClick={() => {
                    navigator.clipboard?.writeText(sync.token).then(() => setSyncMsg('Токен скопирован — передай его новому пользователю для подключения.')).catch(() => setSyncMsg('Админ-токен: ' + sync.token));
                    track('admin_token_copy');
                  }}>
                  🔑 скопировать токен для нового пользователя
                </button>
              )}
            </div>
            <div className="pb-3">
              <button className="dd-action strong" style={{ width: '100%' }} disabled={syncBusy} onClick={doSync}>
                {syncBusy ? 'Синхронизирую…' : 'Синхронизировать'}
              </button>
              <button className="dd-link-btn" style={{ display: 'block', margin: '0 auto', color: 'var(--warn)', fontSize: 12 }}
                onClick={() => { saveSync(null); setSync(null); setSyncMsg('Устройство отключено от синхронизации (данные на месте).'); }}>отключить устройство</button>
              {sync?.role === 'admin' && (
                <button className="dd-link-btn" style={{ display: 'block', margin: '4px auto 0', fontSize: 12 }}
                  onClick={doMetrics}>витрина метрик семьи</button>
              )}
            </div>
          </>
        ) : (
          <div className="py-3">
            <div className="text-sm mb-2">Подключить устройство к семейному серверу</div>
            <input className="dd-input" placeholder="адрес сервера, напр. http://192.168.1.50:8687" value={srvAddr} onChange={e => setSrvAddr(e.target.value)} />
            <input className="dd-input mt-2" placeholder="твоё имя в семье" value={nick} onChange={e => setNick(e.target.value)} />
            <input className="dd-input mt-2" placeholder="админ-токен (для второго и далее участников)" value={adminTok} onChange={e => setAdminTok(e.target.value)} />
            <div className="text-[11px] mt-1" style={{ color: 'var(--mut)' }}>первый подключившийся становится администратором; остальных подключает админ своим токеном</div>
            <button className="dd-action strong mt-2" disabled={syncBusy || !srvAddr.trim()} onClick={doRegister}>
              {syncBusy ? 'Подключаю…' : 'Подключить'}
            </button>
          </div>
        )}
        {syncMsg && <div className="text-[12px] pb-3" style={{ color: 'var(--acc-fg)' }}>{syncMsg}</div>}
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

      <Sheet open={!!metrics} onClose={() => setMetrics(null)} title="Витрина метрик" note="Последние 30 дней · только счётчики, без содержимого дневников">
        {metrics && (
          <div>
            {metrics.users.map(u => (
              <div key={u.nickname} className="py-2" style={{ borderBottom: '1px solid var(--tr)' }}>
                <div className="text-sm font-semibold">{u.nickname}</div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--mut)' }}>
                  дней с записями: <b className="dd-num">{u.activeDays}</b> · записей: <b className="dd-num">{u.entries}</b> · открытий: <b className="dd-num">{u.appOpens}</b>
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--mut)' }}>
                  функции: {u.topEvents.filter(([k]) => k !== 'app_open').slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(' · ') || '—'}
                </div>
              </div>
            ))}
            <div className="py-2" style={{ borderBottom: '1px solid var(--tr)' }}>
              <div className="text-[12px]" style={{ color: 'var(--mut)' }}>
                сессии: онлайн <b className="dd-num">{metrics.sessions.online}</b> · офлайн <b className="dd-num">{metrics.sessions.offline}</b>
                {metrics.sessions.online + metrics.sessions.offline > 0 && (
                  <> (офлайн {Math.round(metrics.sessions.offline / (metrics.sessions.online + metrics.sessions.offline) * 100)}%)</>
                )}
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--mut)' }}>
                баннеры: показов <b className="dd-num">{metrics.banners.shown}</b> · закрытий <b className="dd-num">{metrics.banners.dismissed}</b>
              </div>
            </div>
            <div className="py-2">
              <div className="text-[11px] mb-1" style={{ color: 'var(--mut)' }}>записи по дням (все вместе)</div>
              <MetricsSpark data={metrics.perDay.map(d => d.n)} />
            </div>
          </div>
        )}
      </Sheet>
      {metricsErr && (
        <Modal open={!!metricsErr} onClose={() => setMetricsErr(null)}>
          <p className="dd-modal-text">Витрина не открылась: {metricsErr}</p>
          <div className="dd-modal-row"><button className="dd-action strong" onClick={() => setMetricsErr(null)}>Понятно</button></div>
        </Modal>
      )}

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


function MetricsSpark({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="text-[11px]" style={{ color: 'var(--mut)' }}>мало данных</div>;
  const W = 300, H = 56, pad = 4;
  const max = Math.max(...data, 1);
  const x = (i: number) => pad + (W - 2 * pad) * (i / (data.length - 1));
  const y = (v: number) => pad + (H - 2 * pad) * (1 - v / max);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 56 }}>
      <polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="1.5" opacity=".85" />
      <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="var(--tr)" strokeWidth="1" />
    </svg>
  );
}
