/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { nativeHarness, nativeSkip } from './helpers/native-fixture.js';
import { compatibilityFixture } from './fixtures/native-compatibility.js';

async function action(page: Page, id: string, result: string, expected = 'complete') {
  await page.locator('#' + id).click();
  await page.locator(`#state[data-${result}="${expected}"]`).waitFor({ state: 'attached' });
}

test('native HTTP, cross-origin iframe keyboard focus, popup return and text reflow', {
  skip: nativeSkip, timeout: 100_000,
}, async t => {
  const harness = await nativeHarness(t);
  const fixture = await compatibilityFixture(harness.addCleanup);
  const browser = await harness.launch({ profile: 'interaction', localTestDomain: true });
  const page = await browser.context.newPage();
  const health = await page.goto(`http://hbrowser.test:${fixture.primary.port}/health`);
  assert.equal(health?.status(), 200);
  assert.equal(fixture.counts.hostnameHealth, 1, 'The browser must reach the loopback socket with the actual development Host.');
  await page.goto(fixture.primary.origin);
  const frame = page.frameLocator('iframe');
  await frame.locator('#inside').waitFor();
  await page.locator('#messages[data-same-origin-blocked="true"]').waitFor({ state: 'attached' });
  await page.locator('#before').focus();
  await page.keyboard.press('Tab');
  // Firefox can focus the embedded document before its first control. Keep that
  // accessible document stop; verify it explicitly before the next Tab.
  const iframeDocumentStop = !(await frame.locator('#inside').evaluate(element => element === element.ownerDocument.activeElement));
  if (iframeDocumentStop) {
    assert.equal(await page.locator('iframe').evaluate(element => element === element.ownerDocument.activeElement), true);
    assert.equal(await frame.locator('body').evaluate(element => element === element.ownerDocument.activeElement), true);
    await page.keyboard.press('Tab');
  }
  assert.equal(await frame.locator('#inside').evaluate(element => element === element.ownerDocument.activeElement), true);
  await page.keyboard.type('fixture');
  await page.keyboard.press('Tab');
  assert.equal(await frame.locator('#submit').evaluate(element => element === element.ownerDocument.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('#messages[data-frame="received"]').waitFor({ state: 'attached' });
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#after').evaluate(element => element === element.ownerDocument.activeElement), true);

  const originalFont = await page.locator('body').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.locator('#text-size').click();
  assert.equal(await page.locator('body').evaluate(element => parseFloat(getComputedStyle(element).fontSize)), originalFont * 2);
  assert.equal(await page.locator('#open').isVisible(), true);
  // This exercises 200% fixture text reflow, not Firefox chrome zoom or a screen reader.
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#open').click();
  const popup = await popupPromise;
  await popup.locator('#return').waitFor();
  assert.equal(new URL(popup.url()).origin, fixture.secondary.origin);
  assert.equal(await popup.opener(), page);
  await popup.locator('#return').focus();
  const popupClosed = popup.waitForEvent('close');
  // The handler closes its own window synchronously; Juggler can report that
  // closure before acknowledging keyup. The parent message below still has to
  // prove that the actual button action completed.
  await popup.keyboard.press('Enter').catch(error => { if (!popup.isClosed()) throw error; });
  await popupClosed;
  await page.locator('#messages[data-popup="received"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#open').evaluate(element => element === element.ownerDocument.activeElement), true);
  assert.equal(browser.context.isClosed(), false);
  const navigation = page.waitForEvent('framenavigated', { predicate: value => value.parentFrame() === page.mainFrame() });
  await page.locator('#reload-frame').click();
  await navigation;
  await frame.locator('#inside').waitFor();
  assert.equal(await frame.locator('#inside').inputValue(), '');
  assert.ok(fixture.counts.secondary >= 4);
  t.diagnostic(JSON.stringify({ fixtureTransport: 'native_HTTP_sockets', developmentHostnameResolvedLocally: true,
    iframe: 'cross_origin_same_site_different_ports', keyboardFocusAndPostMessage: true, crossOriginPopupReturn: true,
    iframeReload: true, iframeDocumentStop, textReflow200Percent: true, browserChromeZoomTested: false, externalNavigations: 0 }));
  await harness.close(browser);
});

test('native URL worker, service worker, persistent storage, upload and consent-preserving media API checks', {
  skip: nativeSkip, timeout: 150_000,
}, async t => {
  const harness = await nativeHarness(t);
  const fixture = await compatibilityFixture(harness.addCleanup);
  let browser = await harness.launch({ profile: 'platform' });
  let page = await browser.context.newPage();
  await page.goto(fixture.primary.origin + '/platform');
  await action(page, 'worker', 'worker');
  assert.equal(fixture.counts.workerScripts, 1, 'A dedicated worker script must be fetched over native HTTP.');
  await action(page, 'service-worker', 'service');
  assert.ok(fixture.counts.serviceScripts >= 1);
  assert.equal(fixture.counts.unexpectedServiceFetches, 0, 'The installed service worker must handle its own probe.');
  await action(page, 'write-storage', 'storage', 'written');
  await page.reload();
  await action(page, 'read-storage', 'storage', 'read');
  for (const name of ['local', 'session', 'indexed', 'cache']) assert.equal(await page.locator('#state').getAttribute('data-' + name), 'true', name);

  await action(page, 'capabilities', 'capabilities');
  const capabilities = await page.locator('#state').evaluate(element => {
    const names = ['secure-context', 'media-devices', 'constraints', 'notification', 'notification-query', 'peer-connection',
      'document-model-context', 'document-get-tools', 'document-execute-tool',
      'navigator-model-context', 'navigator-get-tools', 'navigator-execute-tool'];
    return Object.fromEntries(names.map(name => [name, element.getAttribute('data-' + name)]));
  });
  assert.equal(capabilities['secure-context'], 'true');
  assert.equal(capabilities['media-devices'], 'true');
  assert.equal(capabilities.constraints, 'true');
  assert.ok(['default', 'denied'].includes(capabilities.notification!));
  assert.ok(['prompt', 'denied', 'unsupported'].includes(capabilities['notification-query']!));
  await action(page, 'media', 'media');
  await page.locator('#file').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from(fixture.upload) });
  await action(page, 'upload', 'upload');
  assert.equal(fixture.counts.uploads, 1);
  await harness.close(browser);

  browser = await harness.launch({ profile: 'platform' });
  page = await browser.context.newPage(); // New tab: no sessionStorage cloned from an opener.
  await page.goto(fixture.primary.origin + '/platform');
  await action(page, 'read-storage', 'storage', 'read');
  for (const name of ['local', 'indexed', 'cache']) assert.equal(await page.locator('#state').getAttribute('data-' + name), 'true', name);
  assert.equal(await page.locator('#state').getAttribute('data-session'), 'false');
  await action(page, 'unregister', 'unregister');
  t.diagnostic(JSON.stringify({ fixtureTransport: 'native_HTTP_sockets', urlWorker: true, serviceWorker: true,
    localStorageIndexedDbAndCachePersisted: true, newTabSessionStorageIsolated: true, uploadBodyReceived: true,
    localCanvasVideoTrackCreatedAndStopped: true, permissionsRequested: false, realDeviceCaptureTested: false,
    voiceCallTested: false, notificationDeliveryTested: false, webMcpToolsInvoked: false, capabilities }));
  await harness.close(browser);
});
