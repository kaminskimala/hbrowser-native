/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { launchHBrowser, verifyProduct, type HBrowser } from '../../src/browser/index.js';

export const nativeSkip = process.env.HB_PRODUCT_DIR || process.env.HB_REQUIRE_NATIVE === '1'
  ? false : 'HB_PRODUCT_DIR is unset; this test requires the real HBrowser package, with no fallback.';

export async function waitUntil(check: () => boolean, milliseconds: number, label: string): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
  }
}

/** A real listening socket. No Playwright response interception or app.inject. */
export async function listenLoopback(handler: RequestListener) {
  const server = createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server, origin: `http://127.0.0.1:${address.port}`, port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // Only sockets owned by this fixture, after its browser has been closed.
      server.closeAllConnections();
    }),
  };
}

/** New test workspace; destruction occurs only after every captured browser exits. */
export async function nativeHarness(t: TestContext) {
  assert.ok(process.env.HB_PRODUCT_DIR, 'HB_PRODUCT_DIR must select an installed native HBrowser.');
  const product = await verifyProduct(process.env.HB_PRODUCT_DIR);
  const manifestHash = createHash('sha256').update(await readFile(join(product.directory, 'hbrowser-build.json'))).digest('hex');
  const expected = process.env.HB_EXPECTED_MANIFEST_SHA256;
  if (expected !== undefined) {
    assert.match(expected, /^[a-f0-9]{64}$/, 'HB_EXPECTED_MANIFEST_SHA256 must be a lowercase SHA-256.');
    assert.equal(manifestHash, expected, 'Selected HBrowser differs from the requested qualification build.');
  }
  const root = await mkdtemp(join(tmpdir(), 'hbrowser-compatibility-'));
  const profilesRoot = join(root, 'profiles');
  await mkdir(profilesRoot, { mode: 0o700 });
  const configPath = join(root, 'native.json');
  await writeFile(configPath, '{}\n', { mode: 0o600, flag: 'wx' });
  const sessions: HBrowser[] = [];
  const resources: (() => Promise<void>)[] = [];
  let preserve = false;
  t.diagnostic(JSON.stringify({ kind: 'native_product_provenance', version: product.manifest.version,
    engine: product.manifest.engine, manifestSha256: manifestHash,
    executableSha256: product.manifest.files.find(file => file.path === product.manifest.executable)?.sha256,
    libxulSha256: product.manifest.files.find(file => file.path === 'libxul.so')?.sha256,
    nativeConfiguration: {}, headless: process.env.HB_NATIVE_HEADED !== '1' }));
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures: string[] = [];
    for (const browser of sessions.toReversed()) {
      try { await browser.close(); await browser.closed; }
      catch { preserve = true; failures.push('browser_exit_unconfirmed'); }
    }
    for (const close of resources.toReversed()) {
      try { await close(); } catch { failures.push('fixture_close_failed'); }
    }
    if (!preserve) await rm(root, { recursive: true });
    t.diagnostic(JSON.stringify({ kind: 'native_fixture_cleanup', browserExitsConfirmed: !preserve,
      workspaceRemoved: !preserve, fixtureCloseFailures: failures.filter(value => value === 'fixture_close_failed').length }));
    assert.deepEqual(failures, [], 'Native fixture cleanup failed; uncertain browser resources were preserved.');
  })();
  t.after(cleanup);
  return {
    root, product, cleanup, addCleanup(close: () => Promise<void>) { resources.push(close); },
    async launch(options: { profile?: string; localTestDomain?: boolean } = {}) {
      if (options.localTestDomain) {
        assert.ok(options.profile, 'A test DNS preference requires an explicitly named fixture profile.');
        const directory = join(profilesRoot, options.profile);
        await mkdir(directory, { mode: 0o700 });
        // Pinned Firefox157 StaticPrefList.yaml:15701 / nsDNSService2.cpp:
        // this one development hostname resolves as localhost. No global hosts,
        // proxy, TLS exception, hardware override or provider response is changed.
        await writeFile(join(directory, 'user.js'), 'user_pref("network.dns.localDomains", "hbrowser.test");\n', { mode: 0o600, flag: 'wx' });
      }
      let browser: HBrowser;
      try {
        browser = await launchHBrowser({ productDir: product.directory, profilesRoot, configPath,
          profile: options.profile, headless: process.env.HB_NATIVE_HEADED !== '1', timeoutMs: 20_000 });
      } catch {
        // A launch may have failed during process observation; retain its files.
        preserve = true;
        throw new Error('native_fixture_launch_failed_resources_preserved');
      }
      sessions.push(browser);
      assert.deepEqual(browser.product.manifest, product.manifest, 'Product changed between verification and launch.');
      browser.context.setDefaultTimeout(8_000);
      browser.context.setDefaultNavigationTimeout(12_000);
      t.diagnostic(JSON.stringify({ kind: 'native_fixture_launch', profileKind: options.profile ? 'named_fixture' : 'temporary',
        testPreferences: options.localTestDomain ? { 'network.dns.localDomains': 'hbrowser.test' } : {} }));
      return browser;
    },
    async close(browser: HBrowser) {
      await browser.close(); await browser.closed;
      if (browser.profile.temporary) await assert.rejects(access(browser.profile.path), { code: 'ENOENT' });
      else await assert.rejects(access(join(browser.profile.path, '.hbrowser-lock')), { code: 'ENOENT' });
    },
  };
}
