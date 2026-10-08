// Каркас: фон-радиальные пресеты с кросс-фейдом, таб-бар (Сегодня · Профиль · Настройки), онбординг
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadSettings, saveSettings, applyTheme, RADIALS, todayISO, type DeviceSettings } from './lib';
import { track } from './store';
import { computeBanner, dismissBanner, BANNER_CHECK_MS, type BannerInfo } from './banner';
import { autoSync } from './sync';
import { Onboarding } from './onboarding';
import { TodayScreen } from './screen-today';
import { AddScreen } from './screen-add';
import { ProfileScreen } from './screen-profile';
import { SettingsScreen } from './screen-settings';
import type { Slot } from './db';

type Tab = 'today' | 'profile' | 'settings';

export default function App() {
  const [settings, setSettingsState] = useState<DeviceSettings>(() => loadSettings());
  const setSettings = (s: DeviceSettings) => { saveSettings(s); setSettingsState(s); };

  const [tab, setTab] = useState<Tab>('today');
  const [date, setDate] = useState(todayISO());
  const [addOpen, setAddOpen] = useState(false);
  const [addSlot, setAddSlot] = useState<Slot | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [banner, setBanner] = useState<BannerInfo | null>(null);

  const dark = useMemo(() => {
    if (settings.theme !== 'auto') return settings.theme === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }, [settings.theme]);

  useEffect(() => { applyTheme(settings.palette, dark); }, [settings.palette, dark]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => { if (settings.theme === 'auto') applyTheme(settings.palette, mq.matches); };
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [settings.palette, settings.theme]);

  useEffect(() => { track('app_open', { online: navigator.onLine, cold: true }); }, []);
  useEffect(() => {
    autoSync();
    const h = () => autoSync();
    window.addEventListener('online', h);
    return () => window.removeEventListener('online', h);
  }, []);

  // Мотивационные баннеры: при старте и каждые 5 минут (окно срыва зависит от времени)
  useEffect(() => {
    if (onboarding) return;
    let alive = true;
    const check = () => computeBanner().then(b => { if (alive && b) setBanner(b); });
    check();
    const t = setInterval(check, BANNER_CHECK_MS);
    return () => { alive = false; clearInterval(t); };
  }, [onboarding]);

  // Автоскрытие таб-бара: скролл вниз или 4 с бездействия; возврат — тап по нижней зоне или скролл вверх
  const [barHidden, setBarHidden] = useState(false);
  const lastY = useRef(0);
  const idleTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY.current + 6) setBarHidden(true);
      else if (y < lastY.current - 6) setBarHidden(false);
      lastY.current = y;
    };
    const onActivity = () => {
      setBarHidden(false);
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => setBarHidden(true), 4000);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerdown', onActivity);
    onActivity();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerdown', onActivity);
      window.clearTimeout(idleTimer.current);
    };
  }, []);

  // Кросс-фейд фоновых радиальных пресетов при смене экрана
  const screen = addOpen ? 'add' : onboarding ? 'onboarding' : tab === 'settings' ? 'settings' : tab === 'profile' ? 'profile' : 'today';
  const bgA = useRef<HTMLDivElement>(null);
  const bgB = useRef<HTMLDivElement>(null);
  const useA = useRef(true);
  useEffect(() => {
    const spots = RADIALS[screen] ?? RADIALS.today;
    const next = useA.current ? bgB.current : bgA.current;
    const cur = useA.current ? bgA.current : bgB.current;
    if (!next || !cur) return;
    spots.forEach((s, i) => {
      next.style.setProperty(`--r${i + 1}x`, s.x);
      next.style.setProperty(`--r${i + 1}y`, s.y);
      next.style.setProperty(`--r${i + 1}s`, s.size);
    });
    next.style.opacity = '1'; cur.style.opacity = '0';
    useA.current = !useA.current;
  }, [screen]);

  if (!settings.onboarded || onboarding) {
    return (
      <>
        <div ref={bgA} className="dd-bg" />
        <div ref={bgB} className="dd-bg" style={{ opacity: 0 }} />
        <Onboarding onDone={() => { setSettings({ ...settings, onboarded: true }); setOnboarding(false); track('onboarding_done'); }} />
      </>
    );
  }

  return (
    <>
      <div ref={bgA} className="dd-bg" />
      <div ref={bgB} className="dd-bg" style={{ opacity: 0 }} />

      {addOpen
        ? <AddScreen date={date} slot={addSlot} onDone={() => setAddOpen(false)} />
        : <>
          {tab === 'today' && (
            <TodayScreen
              date={date} setDate={setDate} showTime={settings.showTime}
              onAdd={slot => { setAddSlot(slot); setAddOpen(true); }}
            />
          )}
          {tab === 'profile' && <ProfileScreen />}
          {banner && !addOpen && (
            <div className={'dd-banner' + (banner.kind === 'warn' ? ' warn' : '')} role="status">
              <div className="text-[13px] flex-1" style={{ lineHeight: 1.4 }}>{banner.text}</div>
              <button className="dd-banner-x" aria-label="Закрыть"
                onClick={() => { dismissBanner(banner.kind); setBanner(null); }}>✕</button>
            </div>
          )}
          {tab === 'settings' && (
            <SettingsScreen settings={settings} setSettings={setSettings} onRestartOnboarding={() => setOnboarding(true)} />
          )}
        </>}

      {!addOpen && barHidden && <div className="dd-tabzone" onClick={() => setBarHidden(false)} />}
      {!addOpen && (
        <nav className={`dd-tabbar${barHidden ? ' hidden' : ''}`}>
          <TabBtn on={tab === 'today'} icon="◍" label="Сегодня"
            onClick={() => { setTab('today'); setDate(todayISO()); /* повторный тап — к текущей дате */ }} />
          <TabBtn on={tab === 'profile'} icon="◔" label="Профиль" onClick={() => setTab('profile')} />
          <TabBtn on={tab === 'settings'} icon="⚙︎" label="Настройки" onClick={() => setTab('settings')} />
        </nav>
      )}
    </>
  );
}

function TabBtn({ on, icon, label, onClick }: { on: boolean; icon: string; label: string; onClick: () => void }) {
  return (
    <button className={`dd-tab${on ? ' on' : ''}`} onClick={onClick}>
      <span className="ti">{icon}</span>{label}
    </button>
  );
}
