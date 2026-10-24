// Вкладка «Семья»: синхронизация (все роли) + витрина метрик и токен (админ).
// v0.4.1: выделена из Настроек — «всё семейное в одном месте» (В., 11.10).
import { useEffect, useState } from 'react';
import { loadSync, saveSync, registerDevice, runSync, syncStatusText, type SyncSettings } from './sync';
import { fetchMetrics, type MetricsData } from './metrics';
import { track } from './store';

export function FamilyScreen({ isAdmin }: { isAdmin: boolean }) {
  const [sync, setSync] = useState<SyncSettings | null>(() => loadSync());
  const [srvAddr, setSrvAddr] = useState('');
  const [nick, setNick] = useState('');
  const [adminTok, setAdminTok] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hcode, setHcode] = useState<string | null>(null);

  async function loadHcode() {
    // код моста Apple Health: показываем, когда синк настроен
    const st = loadSync();
    if (!st) return;
    try {
      const r = await fetch(st.server.replace(/\/+$/, '') + '/health/code', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token },
        body: '{}', signal: AbortSignal.timeout(8000),
      });
      const j = r.ok ? await r.json() : null;
      if (j?.code) setHcode(j.code);
    } catch { /* тихо: заглушка предложит повторить */ }
  }

  useEffect(() => { loadHcode(); }, [sync?.lastOk]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doRegister() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const st = await registerDevice(srvAddr.trim(), nick.trim() || 'я', adminTok.trim() || undefined);
      // А4: единое имя — серверный nickname = displayName профиля (подтянет витрина)
      saveSync(st); setSync(st);
      setMsg(`Подключено: ${st.nickname} (${st.role}). Теперь «Синхронизировать».`);
    } catch (e) { setMsg(`Не получилось: ${(e as Error).message}`); }
    setBusy(false);
  }

  async function doSync() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await runSync();
      setMsg(r.ok ? 'Синхронизация прошла.' : `Синк не удался: ${r.error}`);
      setSync(loadSync());
      track('sync_manual', {});
    } catch (e) { setMsg(`Синк не удался: ${(e as Error).message}`); }
    setBusy(false);
  }

  return (
    <div className="min-h-screen px-4 pt-6 pb-28" style={{ overflowX: 'hidden' }}>
      <h1 className="text-xl font-bold mb-4">Семья</h1>

      <div className="dd-card px-4 py-1">
        {sync ? (
          <>
            <div className="py-3">
              <div className="text-sm">{syncStatusText()}</div>
              <div className="text-[0.6875rem] mt-1" style={{ color: 'var(--mut)', wordBreak: 'break-all' }}>{sync.server}</div>
            </div>
            <div className="pb-3">
              <button className="dd-action strong" style={{ width: '100%' }} disabled={busy} onClick={doSync}>
                {busy ? 'Синхронизирую…' : 'Синхронизировать'}
              </button>
              <button className="dd-action" style={{ width: '100%', marginTop: 8, color: 'var(--warn)' }}
                onClick={() => { saveSync(null); setSync(null); setMsg('Устройство отключено от синхронизации (данные на месте).'); }}>Отключить устройство</button>
              {isAdmin && (
                <button className="dd-action" style={{ width: '100%', marginTop: 8 }}
                  onClick={() => {
                    navigator.clipboard?.writeText(sync.token)
                      .then(() => setMsg('Токен скопирован — передай его новому пользователю для подключения.'))
                      .catch(() => setMsg('Токен: ' + sync.token));
                    track('admin_token_copy');
                  }}>Скопировать новый токен</button>
              )}
            </div>
            <div className="py-3" style={{ borderTop: '1px solid var(--tr)' }}>
              <div className="flex justify-between items-center">
                <div className="text-sm">Мост Apple Health</div>
                {hcode && <button className="dd-action" style={{ flex: 'none' }} onClick={() => {
                  navigator.clipboard?.writeText(hcode).then(() => setMsg('Код моста скопирован — вставь его в шорткат (инструкция в Obsidian).')).catch(() => setMsg('Код моста: ' + hcode));
                  track('health_code_copy');
                }}>Скопировать код</button>}
              </div>
              {hcode ? (
                <div className="flex gap-2 items-center mt-2">
                  <button className="dd-action" style={{ flex: 'none' }} onClick={async () => {
                    const st = loadSync(); if (!st) return;
                    try {
                      const r = await fetch(st.server.replace(/\/+$/, '') + '/health/code', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token },
                        body: JSON.stringify({ reset: true }), signal: AbortSignal.timeout(8000),
                      });
                      const j = await r.json();
                      if (j.code) { setHcode(j.code); setMsg('Код обновлён — старый больше не работает, обнови шорткат.'); }
                    } catch { setMsg('Не удалось обновить код.'); }
                    track('health_code_reset');
                  }}>Обновить</button>
                </div>
              ) : (
                <div className="flex gap-2 items-center mt-2 flex-wrap">
                  <span className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>код недоступен — сервер старой версии (обнови server.py на NAS)</span>
                  <button className="dd-action" style={{ flex: 'none' }} onClick={loadHcode}>повторить</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="py-3">
            <div className="text-sm mb-2">Подключить устройство к семейному серверу</div>
            <input className="dd-input" placeholder="адрес сервера, напр. http://192.168.1.50:8687" value={srvAddr} onChange={e => setSrvAddr(e.target.value)} />
            <input className="dd-input mt-2" placeholder="твоё имя в семье" value={nick} onChange={e => setNick(e.target.value)} />
            <input className="dd-input mt-2" placeholder="админ-токен (для второго и далее участников)" value={adminTok} onChange={e => setAdminTok(e.target.value)} />
            <div className="text-[0.6875rem] mt-1" style={{ color: 'var(--mut)' }}>первый подключившийся становится администратором; остальных подключает админ своим токеном</div>
            <button className="dd-action strong mt-2" disabled={busy || !srvAddr.trim()} onClick={doRegister}>
              {busy ? 'Подключаю…' : 'Подключить'}
            </button>
          </div>
        )}
        {msg && <div className="text-[0.75rem] pb-3" style={{ color: 'var(--acc-fg)' }}>{msg}</div>}
      </div>

      {sync && isAdmin && <MetricsCard />}
    </div>
  );
}

function MetricsCard() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setErr(null);
    try { setData(await fetchMetrics(30)); track('metrics_open'); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  useEffect(() => { load(); }, []); // витрина грузится сразу при входе во вкладку
  if (!data && !err && !busy) return null;
  if (busy) return <div className="dd-card p-4 mt-4 text-center text-sm" style={{ color: 'var(--mut)' }}>Собираю метрики…</div>;
  if (err) return (
    <div className="dd-card p-4 mt-4 text-center text-sm" style={{ color: 'var(--warn)' }}>
      Витрина не открылась: {err}
      <button className="dd-link-btn" style={{ display: 'block', margin: '6px auto 0' }} onClick={load}>повторить</button>
    </div>
  );
  if (!data) return null;

  const totalEntries = data.users.reduce((s, u) => s + u.entries, 0);
  const online = data.sessions.online, offline = data.sessions.offline;
  const offlineShare = online + offline > 0 ? Math.round(offline / (online + offline) * 100) : 0;

  return (
    <div className="dd-card p-4 mt-4">
      <div className="text-sm font-semibold mb-1">Витрина метрик <span style={{ color: 'var(--mut)', fontWeight: 400 }}>· последние 30 дней</span></div>

      {data.users.map(u => (
        <div key={u.nickname} className="py-2.5" style={{ borderBottom: '1px solid var(--tr)' }}>
          <div className="flex justify-between items-baseline">
            <div className="text-sm font-semibold">{u.nickname}</div>
            <div className="text-[0.75rem] dd-num" style={{ color: 'var(--mut)' }}>
              {u.entries} записей · {u.activeDays} из 30 дней{u.prevDays ? ` (было ${u.prevDays})` : ''}
            </div>
          </div>
          <div className="text-[0.75rem] mt-0.5" style={{ color: 'var(--mut)' }}>
            открывал приложение {u.appOpens} раз
            {u.weightPw != null && ` · вес ${(u.weightPw > 0 ? '+' : '−') + String(Math.abs(u.weightPw)).replace('.', ',')} кг/нед`}
          </div>
        </div>
      ))}

      <div className="py-2.5" style={{ borderBottom: '1px solid var(--tr)' }}>
        <div className="text-[0.75rem]" style={{ color: 'var(--mut)' }}>
          регулярность: <b className="dd-num">{data.perDay.length}</b> дней с записями за месяц, всего <b className="dd-num">{totalEntries}</b> записей
        </div>
        <div className="text-[0.75rem] mt-0.5" style={{ color: 'var(--mut)' }}>
          сессии: <b className="dd-num">{online}</b> онлайн · <b className="dd-num">{offline}</b> офлайн ({offlineShare}% времени без сети — данные не терялись)
        </div>
        <div className="text-[0.75rem] mt-0.5" style={{ color: 'var(--mut)' }}>
          баннеры: показов <b className="dd-num">{data.banners.shown}</b>, закрытий <b className="dd-num">{data.banners.dismissed}</b>
          {data.banners.shown > 0 && ` (${Math.round(data.banners.dismissed / data.banners.shown * 100)}%)`}
        </div>
      </div>

      <div className="py-2">
        <div className="text-[0.6875rem] mb-1" style={{ color: 'var(--mut)' }}>записи по дням (вся семья)</div>
        <MetricsSpark data={data.perDay.map(d => d.n)} />
      </div>

      <button className="dd-link-btn" style={{ display: 'block', margin: '4px auto 0', fontSize: '0.75rem' }} onClick={load}>обновить</button>
    </div>
  );
}

function MetricsSpark({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="text-[0.6875rem]" style={{ color: 'var(--mut)' }}>пока мало данных — появится через несколько дней</div>;
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
