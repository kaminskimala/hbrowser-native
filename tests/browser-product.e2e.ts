/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchHBrowser, type HBrowser } from '../src/browser/index.js';

test('packaged HBrowser loads native configuration, preserves a named profile and isolates a temporary profile', {
  skip: process.env.HB_PRODUCT_DIR || process.env.HB_REQUIRE_NATIVE === '1' ? false : 'HB_PRODUCT_DIR is unset: build and package the native HBrowser engine first; no fallback browser is used.',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.HB_PRODUCT_DIR, 'HB_REQUIRE_NATIVE=1 requires HB_PRODUCT_DIR pointing to a packaged native HBrowser build.');
  const root = await mkdtemp(join(tmpdir(), 'hbrowser-native-e2e-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>HBrowser native smoke</title><script>document.documentElement.dataset.privacy = String(navigator.globalPrivacyControl);</script><p>Local engine validation</p>');
  });
  let browser: HBrowser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    // A real privacy preference exercises native file loading without fabricating a device identity.
    const configPath = join(root, 'native.json');
    await writeFile(configPath, JSON.stringify({ 'navigator.globalPrivacyControl': false }), { mode: 0o600 });
    const options = { productDir: process.env.HB_PRODUCT_DIR, profilesRoot: join(root, 'profiles'), configPath, headless: true };
    browser = await launchHBrowser({ ...options, profile: 'native-smoke' });
    let page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(url);
    assert.equal(await page.title(), 'HBrowser native smoke');
    assert.match(await page.evaluate(() => navigator.userAgent), /Gecko\/\d+/);
    assert.equal(await page.locator('html').getAttribute('data-privacy'), 'false');
    await browser.context.addCookies([{ name: 'hbrowser_persistent', value: 'saved', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await browser.close();
    await writeFile(configPath, JSON.stringify({ 'navigator.globalPrivacyControl': true }));
    browser = await launchHBrowser({ ...options, profile: 'native-smoke' });
    page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(url);
    assert.equal(await page.locator('html').getAttribute('data-privacy'), 'true');
    assert.equal((await browser.context.cookies(url)).find(cookie => cookie.name === 'hbrowser_persistent')?.value, 'saved');
    await browser.close();
    browser = await launchHBrowser(options);
    page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(url);
    assert.equal((await browser.context.cookies(url)).some(cookie => cookie.name === 'hbrowser_persistent'), false);
    await browser.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged HBrowser updates CSS and existing media query listeners when contrast changes', {
  skip: process.env.HB_PRODUCT_DIR || process.env.HB_REQUIRE_NATIVE === '1' ? false : 'HB_PRODUCT_DIR is unset: build and package the native HBrowser engine first; no fallback browser is used.',
  timeout: 90_000,
}, async () => {
  assert.ok(process.env.HB_PRODUCT_DIR, 'HB_REQUIRE_NATIVE=1 requires HB_PRODUCT_DIR pointing to a packaged native HBrowser build.');
  const root = await mkdtemp(join(tmpdir(), 'hbrowser-contrast-e2e-'));
  const fixture = `<!doctype html><meta charset="utf-8"><title>Native contrast regression</title>
    <style>#probe { --contrast: no-preference } @media (prefers-contrast: more) { #probe { --contrast: more } }</style>
    <p id="probe">Contrast</p><script>
      const query = matchMedia('(prefers-contrast: more)');
      const changes = [];
      const publish = () => {
        document.querySelector('#probe').dataset.matches = String(query.matches);
        document.querySelector('#probe').dataset.changes = JSON.stringify(changes);
      };
      query.addEventListener('change', event => { changes.push(event.matches); publish(); });
      publish();
    </script>`;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture + (request.url === '/' ? '<iframe name="contrast-frame" src="/frame"></iframe>' : ''));
  });
  let browser: HBrowser | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await launchHBrowser({ productDir: process.env.HB_PRODUCT_DIR, profilesRoot: join(root, 'profiles'), headless: true });
    await browser.context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.emulateMedia({ contrast: 'no-preference' });
    await page.goto(origin, { waitUntil: 'load', timeout: 15_000 });
    const frame = page.frame({ name: 'contrast-frame' });
    assert.ok(frame);
    for (const target of [page, frame]) {
      assert.equal(await target.locator('#probe').getAttribute('data-matches'), 'false');
      assert.equal(await target.locator('#probe').getAttribute('data-changes'), '[]');
    }
    const expectedChanges: boolean[] = [];
    for (const more of [true, false, true, false]) {
      expectedChanges.push(more);
      const contrast = more ? 'more' : 'no-preference';
      await page.emulateMedia({ contrast });
      for (const target of [page, frame]) {
        // The page owns these MediaQueryList objects from before the change.
        // Reading their event trace through DOM also works in Camoufox's isolated world.
        await target.waitForFunction(expected => {
          const probe = document.querySelector<HTMLElement>('#probe');
          return probe?.dataset.matches === String(expected.more)
            && probe.dataset.changes === expected.changes
            && getComputedStyle(probe).getPropertyValue('--contrast').trim() === expected.contrast;
        }, { more, changes: JSON.stringify(expectedChanges), contrast }, { timeout: 10_000 });
        assert.deepEqual(JSON.parse((await target.locator('#probe').getAttribute('data-changes'))!), expectedChanges);
      }
    }
    await page.emulateMedia({ contrast: null });
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
