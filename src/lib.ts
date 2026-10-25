// Утилиты: даты, КБЖУ-эвристика, идентификаторы, палитры/тема, метрики-трекер

export interface PaletteTokens {
  bg: string; bg2: string; bg3: string; panel: string;
  glass: string; glassStrong: string;
  tx: string; mut: string;
  acc: string; acc2: string; accFg: string;
  tr: string; ok: string; warn: string;
  veil: string;
  r1: string; r2: string; // радиальные пятна (цвета ×1)
}

export interface Palette { key: string; name: string; light: PaletteTokens; dark: PaletteTokens; }

const G = (o: Partial<PaletteTokens>): PaletteTokens => ({
  bg: '#F7F9FB', bg2: '#E7EDF3', bg3: '#DCE6EF', panel: '#F1F4F8', glass: 'rgba(255,255,255,.60)',
  glassStrong: 'rgba(255,255,255,.78)', tx: '#1B2026', mut: '#8B929C', acc: '#44748F',
  acc2: '#6E9BBB', accFg: '#3A647B', tr: 'rgba(27,32,38,.07)', ok: '#3F9B6C',
  warn: '#C0523C', veil: 'rgba(68,116,143,.10)', r1: 'rgba(68,116,143,.12)',
  r2: 'rgba(110,155,187,.10)', ...o,
});

export const PALETTES: Palette[] = [
  { key: 'graphite', name: 'Графит',
    light: G({}),
    dark: G({ bg:'#14171B', bg2:'#18202A', bg3:'#1E2A38', panel:'#1C232D', glass:'rgba(255,255,255,.065)', glassStrong:'rgba(255,255,255,.10)', tx:'#E9EDF2', mut:'#A9AFBA', acc:'#7FA8C9', acc2:'#AECBE2', accFg:'#9ABCD9', tr:'rgba(255,255,255,.09)', ok:'#6FC79A', warn:'#E0836B', veil:'rgba(127,168,201,.12)', r1:'rgba(127,168,201,.18)', r2:'rgba(110,155,187,.14)' }) },
  { key: 'azure', name: 'Лазурь',
    light: G({ bg:'#F7FAFC', bg2:'#E8F1F7', bg3:'#DCEAF4', panel:'#EAF2F8', tx:'#12212E', mut:'#7C93A3', acc:'#1F7FA8', acc2:'#4FB3DD', accFg:'#1B6E92', tr:'rgba(18,33,46,.07)', veil:'rgba(31,127,168,.10)', r1:'rgba(31,127,168,.12)', r2:'rgba(79,179,221,.10)' }),
    dark: G({ bg:'#0D1B2A', bg2:'#12283C', bg3:'#17324A', panel:'#152A3F', glass:'rgba(255,255,255,.07)', glassStrong:'rgba(255,255,255,.11)', tx:'#E8F0F5', mut:'#A3B7C6', acc:'#4FB3DD', acc2:'#8AD1EE', accFg:'#6FC3E5', tr:'rgba(255,255,255,.09)', ok:'#6FC79A', warn:'#E0836B', veil:'rgba(79,179,221,.14)', r1:'rgba(79,179,221,.20)', r2:'rgba(138,209,238,.14)' }) },
  { key: 'indigo', name: 'Индиго',
    light: G({ bg:'#F8F8FC', bg2:'#EFEFF8', bg3:'#E4E4F2', panel:'#EEEDF6', tx:'#1B1D2C', mut:'#8B8FA8', acc:'#4F55C9', acc2:'#7B80E0', accFg:'#4348AC', tr:'rgba(27,29,44,.07)', veil:'rgba(79,85,201,.09)', r1:'rgba(79,85,201,.11)', r2:'rgba(123,128,224,.10)' }),
    dark: G({ bg:'#131419', bg2:'#181A26', bg3:'#1F2233', panel:'#1B1D2A', glass:'rgba(255,255,255,.065)', glassStrong:'rgba(255,255,255,.10)', tx:'#EBECF3', mut:'#A9ADC2', acc:'#8B90F0', acc2:'#B4B8F7', accFg:'#A3A8F3', tr:'rgba(255,255,255,.09)', ok:'#6FC79A', warn:'#E0836B', veil:'rgba(139,144,240,.12)', r1:'rgba(139,144,240,.18)', r2:'rgba(180,184,247,.13)' }) },
  { key: 'lingon', name: 'Брусника',
    light: G({ bg:'#FAF7F8', bg2:'#F6EEF1', bg3:'#EFE2E8', panel:'#F4ECEF', tx:'#271C21', mut:'#9E8D94', acc:'#B23A5B', acc2:'#D5677F', accFg:'#9C2F4D', tr:'rgba(39,28,33,.07)', veil:'rgba(178,58,91,.09)', r1:'rgba(178,58,91,.11)', r2:'rgba(213,103,127,.09)' }),
    dark: G({ bg:'#171114', bg2:'#1E161B', bg3:'#281C23', panel:'#221920', glass:'rgba(255,255,255,.065)', glassStrong:'rgba(255,255,255,.10)', tx:'#F2EAED', mut:'#BBA9B0', acc:'#E27A97', acc2:'#F2A9BC', accFg:'#EDA2B4', tr:'rgba(255,255,255,.09)', ok:'#6FC79A', warn:'#E0836B', veil:'rgba(226,122,151,.12)', r1:'rgba(226,122,151,.18)', r2:'rgba(242,169,188,.13)' }) },
  { key: 'matcha', name: 'Матча',
    light: G({ bg:'#F8FBF8', bg2:'#EDF6EC', bg3:'#DFEEE0', panel:'#ECF4EC', tx:'#182420', mut:'#7E9386', acc:'#2E9B62', acc2:'#55BE85', accFg:'#25824F', tr:'rgba(24,36,32,.07)', veil:'rgba(46,155,98,.10)', r1:'rgba(46,155,98,.12)', r2:'rgba(85,190,133,.10)' }),
    dark: G({ bg:'#0E1511', bg2:'#121E17', bg3:'#182720', panel:'#17211B', glass:'rgba(255,255,255,.065)', glassStrong:'rgba(255,255,255,.10)', tx:'#E8EFEA', mut:'#A3B5A8', acc:'#63C78F', acc2:'#9FE8BE', accFg:'#8FDCAC', tr:'rgba(255,255,255,.09)', ok:'#6FC79A', warn:'#E0836B', veil:'rgba(99,199,143,.12)', r1:'rgba(99,199,143,.18)', r2:'rgba(159,232,190,.13)' }) },
];

// ── Радиальные пресеты по экранам (интенсивность ×1) ──
export interface RadialSpot { x: string; y: string; colorVar: 'r1' | 'r2'; size: string; }
export const RADIALS: Record<string, RadialSpot[]> = {
  today:    [ { x:'88%', y:'4%',  colorVar:'r1', size:'340px' }, { x:'2%',  y:'96%', colorVar:'r2', size:'300px' } ],
  add:      [ { x:'6%',  y:'2%',  colorVar:'r1', size:'320px' }, { x:'96%', y:'90%', colorVar:'r2', size:'300px' } ],
  history:  [ { x:'92%', y:'90%', colorVar:'r1', size:'320px' }, { x:'0%',  y:'0%',  colorVar:'r2', size:'280px' } ],
  profile:  [ { x:'10%', y:'100%',colorVar:'r1', size:'340px' }, { x:'95%', y:'0%',  colorVar:'r2', size:'260px' } ],
  settings: [ { x:'85%', y:'100%',colorVar:'r1', size:'300px' }, { x:'0%',  y:'6%',  colorVar:'r2', size:'340px' } ],
  onboarding: [ { x:'50%', y:'0%', colorVar:'r1', size:'380px' }, { x:'10%', y:'100%', colorVar:'r2', size:'260px' } ],
};

export function applyTheme(paletteKey: string, dark: boolean, textScale = 1) {
  document.documentElement.style.fontSize = `${16 * textScale}px`;
  const pal = PALETTES.find(p => p.key === paletteKey) ?? PALETTES[0];
  const t = dark ? pal.dark : pal.light;
  const root = document.documentElement;
  (Object.keys(t) as Array<keyof PaletteTokens>).forEach(k => root.style.setProperty(`--${k}`, t[k]));
  root.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? pal.dark.bg : pal.light.bg);
}

// ── Настройки устройства (не синхронизируются) ──
export interface DeviceSettings {
  /** масштаб текста: 1 = обычный, 1.15 = крупный, 1.3 = очень крупный */
  textScale?: number;
  palette: string; theme: 'auto' | 'light' | 'dark'; showTime: 'snacks' | 'all'; onboarded: boolean;
  /** рассчитывать калории из БЖУ при создании продуктов (по умолчанию вкл) */
  calcKcal: boolean;
  /** факт-карточки и тосты достижений (v0.7.6; доска заработанного остаётся всегда) */
  factsOn: boolean;
}
const DEF: DeviceSettings = { palette: 'graphite', theme: 'auto', showTime: 'snacks', onboarded: false, calcKcal: true, factsOn: true, textScale: 1 };
export function loadSettings(): DeviceSettings {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem('dd-settings') ?? '{}') }; } catch { return DEF; }
}
export function saveSettings(s: DeviceSettings) { localStorage.setItem('dd-settings', JSON.stringify(s)); }

// ── Даты ──
/** нормализация поиска: ё -> е, нижний регистр */
export const normE = (v: string) => v.toLowerCase().replace(/ё/g, 'е');

export const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
export const MONTHS_NOM = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
export const WD_SHORT = ['вс','пн','вт','ср','чт','пт','сб'];
export function toISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fromISO(iso: string): Date { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
export function shiftISO(iso: string, days: number): string { const d = fromISO(iso); d.setDate(d.getDate() + days); return toISO(d); }
export function todayISO(): string { return toISO(new Date()); }
export function humanDate(iso: string): string {
  const d = fromISO(iso); const t = todayISO();
  if (iso === t) return 'Сегодня';
  if (iso === shiftISO(t, -1)) return 'Вчера';
  if (iso === shiftISO(t, 1)) return 'Завтра';
  const thisYear = fromISO(t).getFullYear() === d.getFullYear();
  return thisYear
    ? `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WD_SHORT[d.getDay()]}`
    : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Подпись под датой в шапке: пустая для сегодня/вчера/завтра, для прочих — день недели (+год, если чужой). */
export function headDateSub(iso: string): string {
  const t0 = todayISO();
  if (iso === t0 || iso === shiftISO(t0, -1) || iso === shiftISO(t0, 1)) return '';
  const d = fromISO(iso);
  const y = fromISO(t0).getFullYear() === d.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${WD_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

/** Автоподбор категории по названию (keyword-словарь; можно поменять вручную). */
import categoryKeywords from '../data/category-keywords.json';
export const CATEGORY_KEYWORDS = categoryKeywords as Array<{ cat: string; words: string[] }>;

// служебные категории-суррогаты импорта: для пользователя их не существует (В., 24.10) —
// импортируемое категоризуется словарём по названию; не угадалось — «Прочее»
export const HIDDEN_CATS = ['Импорт OFF', 'Импорт MFP'];

export function guessCategory(name: string): string | null {
  const n = normE(name);
  for (const { cat, words } of CATEGORY_KEYWORDS) {
    if (words.some(w => n.includes(w))) return cat;
  }
  return null;
}

/** Автозаполнение по штрихкоду из Open Food Facts (онлайн). */
export async function lookupBarcode(ean: string): Promise<{ name: string; brand?: string; kcal: number; p: number; f: number; c: number } | { error: string }> {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,product_name_ru,brands,nutriments`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) return { error: 'нет связи с открытой базой' };
    const j = await r.json();
    const pr = j?.product;
    if (!pr) return { error: 'такого кода в открытой базе нет' };
    const nut = pr.nutriments ?? {};
    const kcal = Math.round(nut['energy-kcal_100g'] ?? (Number.isFinite(nut['energy_100g']) ? nut['energy_100g'] / 4.184 : NaN));
    if (!Number.isFinite(kcal)) return { error: 'у этого кода в базе нет КБЖУ' };
    return {
      name: pr.product_name_ru || pr.product_name || '',
      brand: (pr.brands ?? '').split(',')[0]?.trim() || undefined,
      kcal,
      p: Math.round((nut.proteins_100g ?? 0) * 10) / 10,
      f: Math.round((nut.fat_100g ?? 0) * 10) / 10,
      c: Math.round((nut.carbohydrates_100g ?? 0) * 10) / 10,
    };
  } catch {
    return { error: 'нет интернета или база недоступна' };
  }
}

export function nowHM(): string { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

// ── КБЖУ-эвристика ──
const ALCO_RE = /вино|пиво|водк|виски|коньяк|ром|джин|ликёр|ликер|шампан|сидр|вермут|текил|абсент|настойк/i;
/** Физическая состоятельность КБЖУ. true = подозрительно. */
export function kbjuSuspicious(kcal: number, p: number, f: number, c: number, name: string): boolean {
  if (!kcal) return false;
  const est = p * 4 + c * 4 + f * 9;
  if (ALCO_RE.test(name)) return false; // алкоголь: 7 ккал/г не лезет в 4/4/9 — без предупреждений
  return Math.abs(est - kcal) / kcal > 0.25;
}

export const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
/** дробное количество порций: 0,5 / 1 / 1,25 */
export const fmtQty = (n: number) => (Math.round(n * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
export const rnd = (n: number) => Math.round(n);
