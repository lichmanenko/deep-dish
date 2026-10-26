import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = createRequire(import.meta.url)(path.join(ROOT, 'tmp', 'ui-test', 'node_modules', 'playwright-core'));

async function mkClient(name) {
  const prof = path.join(ROOT, 'tmp', 'sync-e2e', name);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.mkdirSync(prof, { recursive: true });
  const ctx = await PW.chromium.launchPersistentContext(prof, {
    channel: 'msedge', headless: true, viewport: { width: 375, height: 812 },
    locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block',
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', e => console.log(`[${name} PAGEERROR]`, String(e).slice(0, 120)));
  return { ctx, page, name };
}
const SERVER = 'http://127.0.0.1:8689';

async function onboard(page) {
  await page.goto('http://127.0.0.1:4175/deep-dish/?nc=' + Date.now());
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2400);
  for (let i = 0; i < 9; i++) {
    const next = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /далее|начать|готово|пропустить|без цели/i.test(x.textContent)); if (b) { b.click(); return 1; } return null; });
    if (!next) break; await page.waitForTimeout(650);
  }
  await page.waitForTimeout(900);
}
async function register(page, nick, adminTok) {
  await page.evaluate(n => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Семья' && x.closest('nav'))?.click(); }, nick);
  await page.waitForTimeout(1000);
  await page.evaluate(([srv, nick2, tok]) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const [a, b, c] = [...document.querySelectorAll('.dd-input')].slice(0, 3);
    set.call(a, srv); a.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(b, nick2); b.dispatchEvent(new Event('input', { bubbles: true }));
    if (c && tok) { set.call(c, tok); c.dispatchEvent(new Event('input', { bubbles: true })); }
  }, [SERVER, nick, adminTok]);
  await page.waitForTimeout(300);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Подключить')?.click(); });
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({
    addr: [...document.querySelectorAll('.dd-input')].slice(0, 2).map(i => i.value),
    connected: !!localStorage.getItem('dd-sync'),
    err: [...document.querySelectorAll('div')].map(d => d.textContent).filter(t => t && /Не получилось/.test(t)).slice(0, 1),
  }));
  console.log(`[${nick}] register:`, JSON.stringify(st));
}
async function manualSync(page, name) {
  // выйти из полноэкранного «Добавить» (там нет таб-бара)
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '‹'); b?.click(); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Семья' && x.closest('nav'))?.click(); });
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Синхронизировать');
    if (!b) return { btn: false, text: document.body.innerText.slice(0, 200) };
    b.click();
    await new Promise(r2 => setTimeout(r2, 2500));
    return { btn: true, text: document.body.innerText.slice(0, 200) };
  });
  console.log(`[${name}] manualSync:`, JSON.stringify(r).slice(0, 200));
}
async function createFood(page, foodName) {
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Сегодня' && x.closest('nav'))?.click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '＋ еда')?.click(); });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '＋ продукт')?.click(); });
  await page.waitForTimeout(900);
  await page.evaluate(fn => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const nameInp = [...document.querySelectorAll('.dd-input')].find(i => i.placeholder.includes('Кофе латте'));
    set.call(nameInp, fn); nameInp.dispatchEvent(new Event('input', { bubbles: true }));
    const kbzu = [...document.querySelectorAll('.dd-field-label')].find(c => c.textContent.trim().startsWith('КБЖУ'));
    const cells = [...kbzu.nextElementSibling.querySelectorAll('input')];
    ['7', '2', '45'].forEach((v, i) => { set.call(cells[i], v); cells[i].dispatchEvent(new Event('input', { bubbles: true })); });
  }, foodName);
  await page.waitForTimeout(400);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Сохранить' && x.className.includes('strong'))?.click(); });
  await page.waitForTimeout(1200);
  console.log(`[A] продукт «${foodName}» создан`);
}
async function searchFood(page, name, q) {
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Сегодня' && x.closest('nav'))?.click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '＋ еда')?.click(); });
  await page.waitForTimeout(1000);
  await page.evaluate(qq => {
    const inp = [...document.querySelectorAll('.dd-input')].find(i => i.placeholder.includes('Поиск'));
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, qq); inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, q);
  await page.waitForTimeout(1400);
  const found = await page.evaluate(q2 => [...document.querySelectorAll('.dd-item')].some(x => x.textContent.toLowerCase().includes(q2.toLowerCase())), q);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '‹')?.click(); });
  await page.waitForTimeout(500);
  console.log(`[${name}] поиск «${q}»:`, found ? 'НАЙДЕН ✓' : 'НЕТ ✗');
  return found;
}

// ── A: регистрация, продукт, синк
const A = await mkClient('A');
await onboard(A.page);
await register(A.page, 'e2e-A', '');
// A — первый на чистой базе (админ); токен берём из его localStorage
const adminTok = await A.page.evaluate(() => (JSON.parse(localStorage.getItem('dd-sync') || '{}').token) || '');
console.log('[A] adminTok:', adminTok ? adminTok.slice(0, 8) + '…' : 'ПУСТ');
await createFood(A.page, 'Кекс столичный Е2Е');
await manualSync(A.page, 'A');

// ── B: регистрация, синк, поиск
const B = await mkClient('B');
await onboard(B.page);
await register(B.page, 'e2e-B', adminTok);
await manualSync(B.page, 'B');
await searchFood(B.page, 'B', 'Кекс столичный');

await A.ctx.close(); await B.ctx.close();
console.log('E2E SYNC DONE');
