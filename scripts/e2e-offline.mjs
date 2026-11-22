import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const scratch = await mkdtemp(join(tmpdir(), 'deepdish-e2e-'));
const portLine = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/;
const api = spawn(process.env.DD_TEST_PYTHON || 'python', [
  '-m', 'uvicorn', '--app-dir', 'backend', 'server:app', '--host', '127.0.0.1', '--port', '0', '--no-access-log',
  '--no-use-colors',
], {
  env: { ...process.env, DD_DB: join(scratch, 'db.sqlite'), DD_BACKUP_DIR: join(scratch, 'backups'),
    DD_BACKUP_STAGING_DIR: join(scratch, 'staging') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const apiClosed = new Promise(resolve => api.once('close', resolve));
let startupError;
api.on('error', error => { startupError = error; });

async function apiAddress() {
  const signal = AbortSignal.timeout(20_000);
  const output = createInterface({ input: api.stderr, signal });
  const startupLog = [];
  for await (const line of output) {
    startupLog.push(line);
    const match = line.match(portLine);
    if (match) return match[1];
  }
  throw new Error(`Test API did not start. ${startupError?.message ?? startupLog.join('\n')}`);
}

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function tabTo(page, control) {
  await control.waitFor();
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await control.evaluate(element => document.activeElement === element)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard navigation could not reach ${control}`);
}

async function checkNavigation(page) {
  const navigation = page.getByRole('navigation', { name: 'Основная навигация' });
  await navigation.waitFor();
  assert.equal(await button(navigation, 'Сегодня').getAttribute('aria-current'), 'page');
  await delay(4_300);
  assert.equal(await navigation.evaluate(element => element.classList.contains('hidden')), false);
  assert.equal(await page.getByRole('dialog', { name: 'Факт о дневнике' }).count(), 0);
  await page.setViewportSize({ width: 320, height: 660 });
  await button(navigation, 'Настройки').click();
  await button(page, 'очень крупный').click();
  await page.getByRole('button', { name: /тёмная/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.getByRole('heading', { name: 'Настройки', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.locator('nav.dd-tabbar.hidden').waitFor({ state: 'attached' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('nav.dd-tabbar:not(.hidden)').waitFor({ state: 'attached' });
  await button(navigation, 'Сегодня').click();
}

async function openFamily(page) {
  const family = button(page.getByRole('navigation'), 'Семья');
  await family.focus();
  await family.press('Enter');
}

async function readDiary(origin, token) {
  const response = await fetch(origin + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ since: 0, changes: [], events: [], client_now: Date.now() }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, 'test diary read was rejected');
  const result = await response.json();
  return result.changes.filter(change => change.kind === 'entries' && !change.body.deletedAt);
}

async function checkExternalSearch(page, context) {
  const endpoint = 'https://world.openfoodfacts.org/**';
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  await context.route(endpoint, async route => {
    const query = new URL(route.request().url()).searchParams.get('search_terms');
    if (query === 'e2e-old') {
      await oldResponse;
      await route.abort().catch(() => {});
    } else if (query === 'e2e-new') {
      await route.fulfill({ json: { products: [{ code: '1', product_name_ru: 'Результат нового поиска',
        nutriments: { 'energy-kcal_100g': 70 } }] } });
    } else {
      await route.fulfill({ status: 503 });
    }
  });

  try {
    await button(page, '＋ еда').click();
    const search = page.getByRole('textbox', { name: 'Поиск продуктов' });
    const isOld = request => request.url().includes('search_terms=e2e-old');
    const started = page.waitForEvent('request', { predicate: isOld });
    await search.fill('e2e-old');
    await started;
    const cancelled = page.waitForEvent('requestfailed', { predicate: isOld });
    await search.fill('e2e-new');
    await cancelled;
    await page.getByText('Результат нового поиска', { exact: true }).waitFor();
    await search.fill('e2e-unavailable');
    await page.getByText('Open Food Facts временно недоступен.', { exact: true }).waitFor();
    await button(page, 'Добавить продукт').waitFor();
    await button(page, 'Назад').click();
  } finally {
    releaseOld();
    await context.unroute(endpoint);
  }
}

let frontend;
let browser;
try {
  const origin = await apiAddress();
  frontend = await preview({ preview: { host: '127.0.0.1', port: 0 } });
  const url = `http://127.0.0.1:${frontend.httpServer.address().port}/deep-dish/`;
  browser = await chromium.launch({ channel: process.env.DD_BROWSER_CHANNEL || undefined });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true,
    hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  await context.route(/^https:\/\//, route => route.abort());
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(url);
  await button(page, 'Пропустить').click();
  await button(page, '＋ еда').waitFor();
  await checkNavigation(page);
  await checkExternalSearch(page, context);
  await openFamily(page);
  await page.getByRole('textbox', { name: 'Адрес сервера' }).fill(origin);
  await page.getByRole('textbox', { name: 'Имя в семье' }).fill('Тест синхронизации');
  const registration = page.waitForResponse(response => response.url() === origin + '/register');
  await button(page, 'Подключить').click();
  const reply = await registration;
  assert.equal(reply.status(), 200);
  const { token } = await reply.json();
  await button(page, 'Синхронизировать').waitFor();
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active));
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await context.setOffline(true);
  await page.close();
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(url);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await button(page, '＋ еда').click();
  await page.getByRole('textbox', { name: 'Поиск продуктов' }).fill('твор');
  const product = page.getByRole('button', { name: /^Творог 5%/ });
  await tabTo(page, product);
  await page.keyboard.press('Enter');
  const addEditor = page.getByRole('dialog');
  const initialWeight = addEditor.getByRole('textbox', { name: 'Вес порции, г' });
  await tabTo(page, initialWeight);
  await initialWeight.fill('125,5');
  await tabTo(page, button(addEditor, 'Сохранить'));
  await page.keyboard.press('Enter');
  await addEditor.waitFor({ state: 'hidden' });
  await button(page, 'Назад').click();
  const fact = page.getByRole('dialog', { name: 'Факт о дневнике' });
  await fact.waitFor();
  await page.keyboard.press('Escape');
  await fact.waitFor({ state: 'hidden' });
  await page.reload();

  const collapse = page.getByRole('button', { name: /^Свернуть записи/ });
  await tabTo(page, collapse);
  await page.keyboard.press('Space');
  const expand = page.getByRole('button', { name: /^Развернуть записи/ });
  assert.equal(await expand.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Enter');
  const entry = page.getByRole('button', { name: /Творог 5% ·/ });
  await tabTo(page, entry);
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Запись', exact: true });
  await editor.waitFor();
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await entry.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Enter');
  const editWeight = editor.getByRole('textbox', { name: 'Вес, г' });
  await tabTo(page, editWeight);
  assert.equal(await editWeight.inputValue(), '125,5');
  await editWeight.fill('150,25');
  await tabTo(page, button(editor, 'Сохранить'));
  await page.keyboard.press('Enter');
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await entry.evaluate(element => document.activeElement === element), true);
  assert.equal((await readDiary(origin, token)).length, 0, 'offline entry already reached the server');

  await context.setOffline(false);
  let diary = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    diary = await readDiary(origin, token);
    if (diary.length) break;
    await delay(400);
  }
  assert.equal(diary.length, 1, 'reconnecting should deliver exactly one entry');
  assert.equal(diary[0].body.grams, 150.25, 'sync must preserve the edited decimal quantity');
  await openFamily(page);
  await button(page, 'Синхронизировать').click();
  await page.getByText('Синхронизация прошла.', { exact: true }).waitFor();
  assert.deepEqual((await readDiary(origin, token)).map(change => change.body.id), [diary[0].body.id]);
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('OK: navigation, first entry, current search results, offline keyboard edit and sync without duplicate');
} finally {
  await browser?.close();
  if (frontend) await new Promise(resolve => frontend.httpServer.close(resolve));
  api.kill();
  await apiClosed;
  await rm(scratch, { recursive: true, force: true });
}
