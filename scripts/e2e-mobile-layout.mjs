import assert from 'node:assert/strict';
import { devices, webkit } from 'playwright-core';
import { preview } from 'vite';

const scenarios = [
  { name: 'iPhone 17, с «Домой»', width: 402, height: 874, safe: [62, 0, 34, 0] },
  { name: 'iPhone 17, Safari с панелями', width: 402, height: 720, safe: [0, 0, 24, 0] },
  { name: 'узкий экран', width: 320, height: 660, safe: [20, 0, 0, 0] },
  { name: 'горизонтальный экран', width: 874, height: 402, safe: [0, 62, 21, 62] },
];
const longProduct = 'Длинноеназваниепродукта'.repeat(2);
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' });

async function showNavigation(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('nav.dd-tabbar:not(.hidden)').waitFor();
}

async function inside(locator, bounds, label) {
  let box;
  for (let attempt = 0; !box && attempt < 3; attempt++) {
    await locator.waitFor();
    box = await locator.boundingBox();
  }
  assert.ok(box, `${label}: элемент отсутствует`);
  assert.ok(box.x >= bounds.left - 1 && box.x + box.width <= bounds.right + 1
    && box.y >= bounds.top - 1 && box.y + box.height <= bounds.bottom + 1,
  `${label}: ${JSON.stringify(box)} за пределами ${JSON.stringify(bounds)}`);
}

async function noHorizontalOverflow(page, width, label) {
  const metrics = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    x: window.scrollX,
    sheet: [...document.querySelectorAll('[role="dialog"]:not([aria-hidden="true"])')]
      .map(panel => panel.scrollWidth - panel.clientWidth),
  }));
  assert.ok(metrics.document <= width + 1 && metrics.body <= width + 1 && metrics.x === 0
    && metrics.sheet.every(value => value <= 1), `${label}: ${JSON.stringify(metrics)}`);
}

async function setVisualViewport(page, height, top) {
  await page.evaluate(({ height, top }) => {
    const viewport = window.visualViewport;
    // Моделируем iOS: область над клавиатурой меняется при прежнем CSS-вьюпорте.
    Object.defineProperties(viewport, {
      height: { configurable: true, value: height },
      offsetTop: { configurable: true, value: top },
    });
    viewport.dispatchEvent(new Event('resize'));
  }, { height, top });
  await page.waitForFunction(height => document.documentElement.style.getPropertyValue('--dd-view-height') === `${height}px`, height);
}

async function checkActivityLayout(page, nav, bounds, name) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('deepdish');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('dayNormas', 'readwrite');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      transaction.objectStore('dayNormas').put({
        date: new Date().toLocaleDateString('sv-SE'),
        kcal: 2000, p: 125, f: 67, c: 225, basis: 'adaptive',
        detail: { tdeeAdaptive: 2000 }, createdAt: Date.now(),
      });
    };
  }));
  await button(nav, 'Профиль').click();
  const trend = button(page, '⚡ тренд');
  await trend.waitFor();
  const controls = ['сидячая', 'лёгкая', 'средняя', 'высокая'].map(label => button(page, label));
  const boxes = await Promise.all(controls.map(control => control.boundingBox()));
  const first = boxes[0], last = boxes.at(-1);
  assert.ok(first && last && boxes.every((box, index) => box
    && Math.abs(box.y - first.y) <= 1 && Math.abs(box.height - first.height) <= 1
    && (index === 0 || box.x >= boxes[index - 1].x + boxes[index - 1].width - 1)),
  `${name}: четыре кнопки активности должны быть в одном ряду`);
  assert.ok(first.x >= bounds.left - 1 && last.x + last.width <= bounds.right + 1,
    `${name}: ряд активности выходит за границы экрана`);
  for (const control of controls) {
    const { scrollWidth, clientWidth, textContent } = await control.evaluate(element => ({
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, textContent: element.textContent,
    }));
    assert.ok(scrollWidth <= clientWidth + 1,
      `${name}: «${textContent}» не помещается в кнопку (${scrollWidth} > ${clientWidth})`);
  }
  await inside(trend, {
    ...bounds, top: first.y + first.height, bottom: Infinity, left: first.x, right: last.x + last.width,
  }, `${name}, отдельный ряд тренда`);
  const trendBox = await trend.boundingBox();
  assert.ok(Math.abs(trendBox.width - (last.x + last.width - first.x)) <= 1,
    `${name}: «Тренд» должен занимать всю ширину ряда`);
}

async function checkLayout(browser, url, { name, width, height, safe }) {
  const context = await browser.newContext({
    ...devices[width > height ? 'iPhone 17 landscape' : 'iPhone 17'],
    viewport: { width, height },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route(/^https:\/\//, route => route.abort());
  await context.route('https://world.openfoodfacts.org/**', route => route.fulfill({
    json: { products: [{ code: '100000001', product_name_ru: longProduct,
      nutriments: { 'energy-kcal_100g': 70 } }] },
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    const [top, right, bottom, left] = safe;
    await page.evaluate(insets => {
      for (const [side, size] of Object.entries(insets)) {
        document.documentElement.style.setProperty(`--dd-safe-${side}`, `${size}px`);
      }
    }, { top, right, bottom, left });
    const bounds = { top, right: width - right, bottom: height - bottom, left };
    await inside(button(page, 'Далее'), bounds, `${name}, онбординг`);
    await button(page, 'Далее').click();
    await button(page, 'Далее').click();
    await page.getByText('вес, кг', { exact: true }).locator('..').getByRole('textbox').fill('82,5');
    await button(page, 'Готово').click();
    await button(page, 'Начать пользоваться').click();

    const nav = page.getByRole('navigation', { name: 'Основная навигация' });
    await button(nav, 'Настройки').click();
    await button(page, 'очень крупный').click();
    await button(page, /тёмная/).click();
    await showNavigation(page);
    await inside(page.getByRole('heading', { name: 'Настройки' }), bounds, `${name}, заголовок`);
    await inside(nav, bounds, `${name}, вкладки`);
    await noHorizontalOverflow(page, width, `${name}, настройки`);
    await button(page, 'Открыть справку').click();
    const help = page.getByRole('dialog', { name: 'Как пользоваться' });
    await help.waitFor();
    await page.waitForFunction(() => document.querySelector('.dd-sheet.show')?.getBoundingClientRect().bottom <= window.innerHeight + 1);
    await inside(help, { ...bounds, left: 0, right: width, bottom: height }, `${name}, длинный лист`);
    await page.keyboard.press('Escape');
    await help.waitFor({ state: 'hidden' });

    await showNavigation(page);
    await button(nav, 'Профиль').click();
    await button(page, 'лёгкая').waitFor();
    await inside(button(page, 'лёгкая'), { ...bounds, bottom: Infinity }, `${name}, активность`);
    await noHorizontalOverflow(page, width, `${name}, профиль`);
    await button(nav, 'Семья').click();
    await inside(page.getByRole('textbox', { name: 'Адрес сервера' }), bounds, `${name}, семья`);
    await noHorizontalOverflow(page, width, `${name}, семья`);

    await button(nav, 'Сегодня').click();
    await button(page, 'Переключить кольцо').waitFor();
    await inside(button(page, 'Переключить кольцо'), bounds, `${name}, кольцо`);
    await inside(button(page, 'Как получить кольцо прогресса'), bounds, `${name}, цель`);
    await noHorizontalOverflow(page, width, `${name}, дневник`);
    await button(page, '＋ еда').click();
    const search = page.getByRole('textbox', { name: 'Поиск продуктов' });
    await search.fill('проверка-длинного-названия');
    await button(page, new RegExp(`^${longProduct}`)).click();
    const longEditor = page.getByRole('dialog', { name: longProduct });
    await longEditor.waitFor();
    await noHorizontalOverflow(page, width, `${name}, длинное название`);
    await page.keyboard.press('Escape');
    await longEditor.waitFor({ state: 'hidden' });
    await search.fill('твор');
    await inside(button(page, 'Очистить поиск'), bounds, `${name}, поиск`);
    await inside(page.getByLabel('Сканировать штрихкод', { exact: true }), bounds, `${name}, сканер`);
    await noHorizontalOverflow(page, width, `${name}, каталог`);
    await button(page, /^Творог 5%/).first().click();
    const editor = page.getByRole('dialog', { name: 'Творог 5%' });
    await editor.waitFor();
    const quantity = editor.getByRole('textbox', { name: 'Вес порции, г' });
    await quantity.fill('125,5');
    const fieldSize = await quantity.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(fieldSize >= 16, `${name}: iOS может приблизить поле ввода`);

    const keyboardTop = 30;
    const keyboardHeight = Math.min(height - 155, 350);
    await setVisualViewport(page, keyboardHeight, keyboardTop);
    const save = button(editor, 'Сохранить');
    await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await inside(editor, { top: keyboardTop + top, bottom: keyboardTop + keyboardHeight, left: 0, right: width },
      `${name}, редактор с клавиатурой`);
    await inside(save, { ...bounds, top: keyboardTop + top, bottom: keyboardTop + keyboardHeight - bottom },
      `${name}, сохранение с клавиатурой`);
    await noHorizontalOverflow(page, width, `${name}, редактор`);
    await save.click();
    await editor.waitFor({ state: 'hidden' });
    await setVisualViewport(page, height, 0);
    await button(page, 'Назад').click();
    const fact = page.getByRole('dialog', { name: 'Факт о дневнике' });
    await fact.waitFor();
    await inside(fact, bounds, `${name}, факт`);
    await button(fact, 'Понятно').click();
    await inside(nav, bounds, `${name}, вкладки после клавиатуры`);
    if (width === 402 && height === 874) {
      await button(page, /Творог 5% ·/).click();
      const edit = page.getByRole('dialog', { name: 'Запись', exact: true });
      const weight = edit.getByRole('textbox', { name: 'Вес, г' });
      assert.equal(await weight.inputValue(), '125,5');
      await weight.fill('150,25');
      await setVisualViewport(page, keyboardHeight, keyboardTop);
      await edit.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await inside(button(edit, 'Сохранить'), { ...bounds, top: keyboardTop + top, bottom: keyboardTop + keyboardHeight - bottom },
        `${name}, сохранение правки с клавиатурой`);
      await button(edit, 'Сохранить').click();
      await edit.waitFor({ state: 'hidden' });
      await setVisualViewport(page, height, 0);
    }
    await showNavigation(page);
    await button(nav, 'Настройки').click();
    await button(page, 'обычный').click();
    await showNavigation(page);
    await checkActivityLayout(page, nav, bounds, name);
    assert.deepEqual(errors, [], `${name}: ошибки браузера`);
    console.log(`OK: ${name}, ${width} × ${height}`);
  } catch (error) {
    throw new Error(`Сценарий ${name} (${width} × ${height})`, { cause: error });
  } finally {
    await context.close();
  }
}

const frontend = await preview({ preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const url = `http://127.0.0.1:${frontend.httpServer.address().port}/deep-dish/`;
  browser = await webkit.launch();
  for (const scenario of scenarios) await checkLayout(browser, url, scenario);
} finally {
  await browser?.close();
  await new Promise(resolve => frontend.httpServer.close(resolve));
}
