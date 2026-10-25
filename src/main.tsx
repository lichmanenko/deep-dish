import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './update';
import { track } from './store';

// Тема: авто по системе (ручной переключатель — в настройках, M0-вёрстка)
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', mq.matches);
applyTheme();
mq.addEventListener('change', applyTheme);

// v0.7.4: ошибки клиента — в события метрик (уедут синком; без внешних сервисов — приватность и 0 ₽)
const errBrief = (m: string) => m.split('\n')[0].slice(0, 160);
window.addEventListener('error', e => {
  track('client_error', { kind: 'js', msg: errBrief(e.message), src: (e.filename || '').split('/').pop(), line: e.lineno });
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  track('client_error', { kind: 'promise', msg: errBrief(r instanceof Error ? r.message : String(r)) });
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
