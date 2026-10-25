// E2E-минимум релизного ритуала (v0.7.4): головлес Edge против vite preview.
// Прогон: 1) npm run build  2) npx vite preview --port 4175 --host 127.0.0.1 &
//         3) node scripts/e2e.mjs
// Чистый профиль в tmp/e2e-profile (создаётся сам), SW заблокированы, ?nc= против кэша.
// playwright-core — из dev-стенда tmp/ui-test/node_modules (в dependencies проекта не входит:
// CI его не гоняет, а прод не зависит)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(import.meta.url)(
  path.join(ROOT, 'tmp', 'ui-test', 'node_modules', 'playwright-core'));

const PROF = path.join(ROOT, 'tmp', 'e2e-profile');
fs.mkdirSync(PROF, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROF, {
  channel: 'msedge', headless: true,
  viewport: { width: 375, height: 812 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block',
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 120)));

let failed = 0;
const ok = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

await page.goto('http://127.0.0.1:4175/deep-dish/?nc=' + Date.now());
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);

const tab = async name => {
  await page.evaluate(n => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === n && x.closest('nav')); b?.click(); }, name);
  await page.waitForTimeout(1000);
};
const clickLast = async (t, strong = false) => { // последний матч: открытые шиты добавляют свои кнопки позже
  await page.evaluate(([t, strong]) => {
    const btns = [...document.querySelectorAll('button')].filter(x => x.textContent.trim() === t && (!strong || x.className.includes('strong')));
    btns[btns.length - 1]?.click();
  }, [t, strong]);
};
const clickText = async (t, exact = true) => {
  await page.evaluate(([t, exact]) => {
    const b = [...document.querySelectorAll('button, [role=button]')].find(x => (exact ? x.textContent.trim() === t : x.textContent.includes(t)));
    b?.click();
  }, [t, exact]);
};

// 1. Онбординг (чистый профиль) → пройти до конца
const body = () => page.evaluate(() => document.body.innerText);
let bt = await body();
if (bt.includes('Добро пожаловать') || bt.includes('онбординг')) {
  for (let i = 0; i < 8; i++) {
    const next = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /далее|начать|готово|пропустить|без цели/i.test(x.textContent));
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });
    if (!next) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1200);
}
bt = await body();
ok('приложение открылось (Сегодня/таб-бар)', bt.includes('Сегодня') && bt.includes('Настройки'));
const tabs = await page.evaluate(() => [...document.querySelectorAll('nav button')].map(b => b.textContent.trim()));
ok('вкладки: ' + tabs.join('/'), tabs.length === 4);

// 3. Добавить еду → создать продукт → сохранить запись
await clickText('＋ Добавить еду');
await page.waitForTimeout(1000);
bt = await body();
ok('экран добавления открыт', bt.includes('＋ продукт'));
await clickText('＋ продукт');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const inputs = [...document.querySelectorAll('.dd-input')];
  const nameInp = inputs.find(i => i.placeholder.includes('Кофе латте'));
  if (nameInp) { set.call(nameInp, 'E2E Суп'); nameInp.dispatchEvent(new Event('input', { bubbles: true })); }
  const kbzu = [...document.querySelectorAll('.dd-field-label')].find(c => c.textContent.trim().startsWith('КБЖУ'));
  const row = kbzu.nextElementSibling; // dd-input-row за лейблом
  const cells = [...row.querySelectorAll('input')];
  ['3', '2', '10'].forEach((v, i) => { if (cells[i]) { set.call(cells[i], v); cells[i].dispatchEvent(new Event('input', { bubbles: true })); } });
});
await page.waitForTimeout(400);
await clickText('Сохранить'); // продукт сохранён, шит закрылся
await page.waitForTimeout(1000);
// найти созданный продукт в выдаче и записать его
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('.dd-input')].find(i => i.placeholder.includes('Поиск'));
  if (!inp) return;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, 'E2E Суп');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1000);
await page.evaluate(() => { const el = [...document.querySelectorAll('.dd-item')].find(x => x.textContent.includes('E2E Суп')); el?.click(); });
await page.waitForTimeout(1000);
await clickText('Сохранить'); // карточка записи: в DOM раньше шита продукта — первый матч
await page.waitForTimeout(1000);
await clickText('‹');
await page.waitForTimeout(1000);
bt = await body();
ok('запись сохранена (E2E Суп на Сегодня)', bt.includes('E2E Суп'));

// 4. Профиль: карточки на месте (мы на Сегодня — таб-бар на месте)
await tab('Профиль');
bt = await body();
ok('профиль: О себе', bt.includes('О себе'));

// 5. Настройки: справка открывается, заглушка моста не падает
await tab('Настройки');
await clickText('Как пользоваться', false);
await page.waitForTimeout(800);
bt = await body();
ok('справка открылась', bt.includes('Запись еды'));
await page.keyboard.press('Escape').catch(() => {});
await clickText('Понятно').catch(() => {});
await page.waitForTimeout(500);

// 6. Тёмная тема — переключение без падения
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('тёмная')); b?.click(); });
await page.waitForTimeout(600);
const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
ok('тёмная тема включилась', dark);

ok('нет pageerror за прогон', errs.length === 0);
if (errs.length) console.log('  ошибки:', JSON.stringify(errs));
await ctx.close();
console.log(failed === 0 ? 'E2E: OK' : `E2E: ${failed} провал(ов)`);
process.exit(failed === 0 ? 0 : 1);
