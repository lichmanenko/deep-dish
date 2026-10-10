// Витрина метрик для администратора (M2 этап 2): агрегаты с сервера, без содержимого дневников.
import { loadSync } from './sync';

export interface MetricsData {
  days: number;
  users: Array<{ nickname: string; activeDays: number; entries: number; appOpens: number; topEvents: Array<[string, number]> }>;
  perDay: Array<{ day: string; n: number }>;
  sessions: { online: number; offline: number };
  banners: { shown: number; dismissed: number };
}

export async function fetchMetrics(days = 30): Promise<MetricsData> {
  const st = loadSync();
  if (!st) throw new Error('синхронизация не настроена');
  const res = await fetch(`${st.server.replace(/\/+$/, '')}/admin/metrics?days=${days}`, {
    headers: { Authorization: 'Bearer ' + st.token },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'только для администратора' : `сервер ответил ${res.status}`);
  return res.json();
}
