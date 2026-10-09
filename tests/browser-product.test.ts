/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, BrowserType } from 'playwright';
import { acquireProfile, launchHBrowser, listProfiles, parseManifest, verifyProduct, type ProductManifest } from '../src/browser/index.js';
import { browserEnvironment, prepareNativeConfig, readPrivateJson, validateProxy } from '../src/browser/config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hbrowser-product-test-'));
  const install = join(root, 'installation');
  await mkdir(install);
  const payload = { 'camoufox-bin': '#!/bin/sh\nexit 1\n', 'libxul.so': 'mock library', 'provenance/patches/0001-hbrowser.patch': 'mock native patch' };
  const manifest: ProductManifest = {
    schemaVersion: 1, product: 'HBrowser', version: '0.2.0-dev.1', platform: 'linux', arch: 'x64',
    engine: { name: 'camoufox', revision: 'a'.repeat(40), firefoxVersion: '135.0.1' },
    executable: 'camoufox-bin', files: [], patches: [],
  };
  for (const [path, content] of Object.entries(payload)) {
    await mkdir(dirname(join(install, path)), { recursive: true });
    await writeFile(join(install, path), content, { mode: path === manifest.executable ? 0o755 : 0o644 });
    manifest.files.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
  }
  manifest.patches = [manifest.files[2]!];
  const save = () => writeFile(join(install, 'hbrowser-build.json'), JSON.stringify(manifest));
  await save();
  return { root, install, manifest, save, profilesRoot: join(root, 'profiles'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function mockLauncher(options: { failLaunch?: boolean; failClose?: boolean; failCloseAfterEvent?: boolean; holdExit?: boolean; noProcessIdentity?: boolean; failExit?: boolean } = {}) {
  const events = new EventEmitter();
  let closed = false;
  let calls = 0;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  let resolveCloseStarted!: () => void;
  const closeStarted = new Promise<void>(resolve => { resolveCloseStarted = resolve; });
  let launchedWith: Parameters<BrowserType['launchPersistentContext']> | undefined;
  const context = Object.assign(events, { isClosed: () => closed, async close() {
    if (options.failClose) throw new Error('DO_NOT_PRINT_RUNTIME_SECRET');
    if (!closed) { closed = true; calls++; events.emit('close'); }
    resolveCloseStarted();
    if (options.failCloseAfterEvent) throw new Error('DO_NOT_PRINT_RUNTIME_SECRET');
    if (!options.holdExit) resolveExit();
    await exited;
  } }) as unknown as BrowserContext;
  const launcher = { async launchPersistentContext(...args: Parameters<BrowserType['launchPersistentContext']>) {
    launchedWith = args;
    if (options.failLaunch) throw new Error('https://user:DO_NOT_PRINT_RUNTIME_SECRET@proxy.invalid');
    return context;
  } } as Pick<BrowserType, 'launchPersistentContext'>;
  const processObserver = async () => {
    if (options.noProcessIdentity) throw new Error('No uniquely identified process');
    return { async waitForExit() {
      if (options.failExit) throw new Error('Exit observation timed out');
      await exited;
    } };
  };
  return { launcher, processObserver, context, events, options, closeStarted, exit: resolveExit,
    get launchedWith() { return launchedWith; }, get closeCalls() { return calls; } };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const cli = fileURLToPath(new URL('../src/browser/cli.js', import.meta.url));
  return new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, HB_PRODUCT_DIR: '', ...env }, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('product integrity covers every runtime file and packaged patch', async () => {
  const files = await fixture();
  try {
    const product = await verifyProduct(files.install);
    assert.equal(product.executablePath, join(files.install, 'camoufox-bin'));
    assert.equal(product.manifest.product, 'HBrowser');
    await writeFile(join(files.install, 'libxul.so'), 'changed engine');
    await assert.rejects(verifyProduct(files.install), { code: 'INTEGRITY_MISMATCH' });
  } finally { await files.cleanup(); }
});

test('unbranded upstream, uncovered engines and patches, and malformed paths are rejected', async () => {
  const files = await fixture();
  try {
    for (const mutation of [
      { product: 'Camoufox' }, { schemaVersion: 2 }, { engine: { ...files.manifest.engine, revision: 'latest' } },
      { executable: '../camoufox-bin' }, { files: files.manifest.files.slice(1) },
      { files: files.manifest.files.filter(file => file.path !== 'libxul.so') },
      { files: [...files.manifest.files, files.manifest.files[0]] }, { patches: [] },
      { patches: [{ path: 'provenance/patches/absent.patch', sha256: 'a'.repeat(64) }] },
    ]) assert.throws(() => parseManifest({ ...files.manifest, ...mutation }), { code: 'INVALID_MANIFEST' });
    for (const path of ['../escape', '/tmp/escape', 'dir/../escape', 'dir//file', 'dir\\file', 'file\0name', './file']) {
      assert.throws(() => parseManifest({ ...files.manifest, files: [...files.manifest.files, { path, sha256: 'a'.repeat(64) }] }), { code: 'INVALID_MANIFEST' });
    }
    await chmod(join(files.install, 'camoufox-bin'), 0o644);
    await assert.rejects(verifyProduct(files.install), { code: 'INVALID_INSTALLATION' });
  } finally { await files.cleanup(); }
});

test('installation rejects unlisted files, symlink files and symlink ancestors', async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.install, 'injected.js'), 'extra runtime code');
    await assert.rejects(verifyProduct(files.install), { code: 'INVALID_INSTALLATION' });
    await rm(join(files.install, 'injected.js'));
    await rename(join(files.install, 'libxul.so'), join(files.root, 'external.so'));
    await symlink(join(files.root, 'external.so'), join(files.install, 'libxul.so'));
    await assert.rejects(verifyProduct(files.install), { code: 'INVALID_INSTALLATION' });
    await rm(join(files.install, 'libxul.so'));
    await rename(join(files.root, 'external.so'), join(files.install, 'libxul.so'));
    await rename(join(files.install, 'provenance'), join(files.root, 'external-provenance'));
    await symlink(join(files.root, 'external-provenance'), join(files.install, 'provenance'));
    await assert.rejects(verifyProduct(files.install), { code: 'INVALID_INSTALLATION' });
  } finally { await files.cleanup(); }
});

test('profile leases exclude competing sessions and preserve persistent user data', async () => {
  const files = await fixture();
  try {
    const first = await acquireProfile({ root: files.profilesRoot, name: 'work-1' });
    await writeFile(join(first.path, 'user-data'), 'keep this');
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'work-1' }), { code: 'PROFILE_LOCKED' });
    assert.deepEqual(await listProfiles(files.profilesRoot), [{ name: 'work-1', locked: true }]);
    await Promise.all([first.release(), first.release()]);
    assert.equal(await readFile(join(first.path, 'user-data'), 'utf8'), 'keep this');
    assert.deepEqual(await listProfiles(files.profilesRoot), [{ name: 'work-1', locked: false }]);
    const reopened = await acquireProfile({ root: files.profilesRoot, name: 'work-1' });
    await reopened.release();
  } finally { await files.cleanup(); }
});

test('temporary profiles are distinct and owned cleanup removes only temporary data', async () => {
  const files = await fixture();
  try {
    const [first, second] = await Promise.all([acquireProfile({ root: files.profilesRoot }), acquireProfile({ root: files.profilesRoot })]);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(await listProfiles(files.profilesRoot), []);
    await first.release();
    await assert.rejects(lstat(first.path), { code: 'ENOENT' });
    assert.ok((await lstat(second.path)).isDirectory());
    await second.release();
  } finally { await files.cleanup(); }
});

test('profiles reject traversal, symlink destinations and cleanup after ownership changes', async () => {
  const files = await fixture();
  try {
    for (const name of ['../outside', '.', '/tmp/profile', 'name/child', '.temporary-1', '']) {
      await assert.rejects(acquireProfile({ root: files.profilesRoot, name }), { code: 'INVALID_PROFILE_NAME' });
    }
    await mkdir(files.profilesRoot, { mode: 0o700 });
    await symlink(files.root, join(files.profilesRoot, 'linked'));
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'linked' }), { code: 'INVALID_PROFILE' });
    const profile = await acquireProfile({ root: files.profilesRoot });
    await writeFile(join(profile.path, '.hbrowser-lock', 'owner.json'), JSON.stringify({ token: 'some-other-owner' }));
    await assert.rejects(profile.release(), { code: 'PROFILE_OWNERSHIP_CHANGED' });
    assert.ok((await lstat(profile.path)).isDirectory());
  } finally { await files.cleanup(); }
});

test('native configuration snapshots are private, immutable from the source and reject server secrets', async () => {
  const files = await fixture();
  const source = join(files.root, 'source.json');
  try {
    await writeFile(source, JSON.stringify({ custom: 'original' }), { mode: 0o600 });
    const native = await prepareNativeConfig(source);
    try {
      assert.equal((await lstat(native.path)).mode & 0o777, 0o600);
      assert.notEqual(native.path, source);
      await writeFile(source, JSON.stringify({ custom: 'changed' }));
      assert.deepEqual(JSON.parse(await readFile(native.path, 'utf8')), { custom: 'original' });
    } finally { await native.cleanup(); }
    await assert.rejects(lstat(native.path), { code: 'ENOENT' });
    for (const value of [[], null, 'text']) {
      await writeFile(source, JSON.stringify(value));
      await assert.rejects(readPrivateJson(source), { code: 'INVALID_CONFIG' });
    }
    await writeFile(source, JSON.stringify({ nested: [{ HCAPTCHA_SECRET: 'DO_NOT_PRINT_SECRET' }] }));
    await assert.rejects(prepareNativeConfig(source), error => {
      assert.doesNotMatch(String(error), /DO_NOT_PRINT_SECRET/);
      return (error as { code: string }).code === 'SERVER_CREDENTIAL_IN_CONFIG';
    });
  } finally { await files.cleanup(); }
});

test('configuration rejects loose permissions, symbolic links, malformed JSON and oversized files', async () => {
  const files = await fixture();
  const source = join(files.root, 'source.json');
  try {
    await writeFile(source, '{}', { mode: 0o644 });
    await assert.rejects(readPrivateJson(source), { code: 'INVALID_CONFIG' });
    await chmod(source, 0o600);
    await chmod(source, 0o4600);
    await assert.rejects(readPrivateJson(source), { code: 'INVALID_CONFIG' });
    await chmod(source, 0o600);
    await symlink(source, join(files.root, 'linked.json'));
    await assert.rejects(readPrivateJson(join(files.root, 'linked.json')), { code: 'INVALID_CONFIG' });
    await writeFile(source, '{');
    await assert.rejects(readPrivateJson(source), { code: 'INVALID_CONFIG' });
    await writeFile(source, JSON.stringify({ value: 'x'.repeat(1024 * 1024) }));
    await assert.rejects(readPrivateJson(source), { code: 'INVALID_CONFIG' });
  } finally { await files.cleanup(); }
});

test('native snapshots preserve exact JSON numbers and reject values unsupported by the native parser', async () => {
  const files = await fixture();
  const source = join(files.root, 'source.json');
  try {
    const text = String.raw`{ "integer": 9007199254740993, "float": 1e300, "label": "\ud83d\ude80", "same": 1, "same": 2, "text": "1e400 \"password\": \\ud800" }` + '\n';
    await writeFile(source, text, { mode: 0o600 });
    const snapshot = await prepareNativeConfig(source);
    try { assert.equal(await readFile(snapshot.path, 'utf8'), text); }
    finally { await snapshot.cleanup(); }
    for (const invalid of ['{"value":"\\ud800"}', '{"\\udfff":1}', '{"v":1e400,"v":0}', '{"v":"\\ud800","v":"ok"}']) {
      await writeFile(source, invalid);
      let unexpected: Awaited<ReturnType<typeof prepareNativeConfig>> | undefined;
      try {
        await assert.rejects(async () => { unexpected = await prepareNativeConfig(source); }, { code: 'INVALID_CONFIG' });
      } finally { await unexpected?.cleanup(); }
    }
    await writeFile(source, String.raw`{"v":{"pa\u0073sword":"PRIVATE_VALUE"},"v":0}`);
    await assert.rejects(prepareNativeConfig(source), error => {
      assert.doesNotMatch(String(error), /PRIVATE_VALUE/);
      return (error as { code: string }).code === 'SERVER_CREDENTIAL_IN_CONFIG';
    });
  } finally { await files.cleanup(); }
});

test('native snapshots reject invalid UTF-8 and overflowing numbers instead of silently rewriting them', async () => {
  const files = await fixture();
  const source = join(files.root, 'source.json');
  try {
    for (const value of [
      Buffer.from([123, 34, 118, 34, 58, 34, 255, 34, 125]),
      '{"v":1e400}',
      '{"nested":[{"v":-1e400}]}',
    ]) {
      await writeFile(source, value, { mode: 0o600 });
      let unexpectedSnapshot: Awaited<ReturnType<typeof prepareNativeConfig>> | undefined;
      try {
        await assert.rejects(async () => { unexpectedSnapshot = await prepareNativeConfig(source); }, { code: 'INVALID_CONFIG' });
      } finally { await unexpectedSnapshot?.cleanup(); }
    }
    await writeFile(source, '{"label":"français 日本語","finite":1e300,"nested":[0,false,null]}');
    const snapshot = await prepareNativeConfig(source);
    try {
      assert.deepEqual(JSON.parse(await readFile(snapshot.path, 'utf8')), {
        label: 'français 日本語', finite: 1e300, nested: [0, false, null],
      });
    } finally { await snapshot.cleanup(); }
  } finally { await files.cleanup(); }
});

test('engine environment excludes application secrets, inherited Camoufox settings and debug logging', () => {
  assert.deepEqual(browserEnvironment('/private/native.json', {
    PATH: '/bin', DISPLAY: ':0', LC_ALL: 'en_US.UTF-8', HCAPTCHA_SECRET: 'NO', CAMOU_CONFIG: 'NO', CAMOU_CONFIG_1: 'NO',
    DEBUG: 'pw:*', AWS_SECRET_ACCESS_KEY: 'NO', HBROWSER_CONFIG_FILE: '/stale/config', MOZ_DISABLE_CONTENT_SANDBOX: '1',
  }), { PATH: '/bin', DISPLAY: ':0', LC_ALL: 'en_US.UTF-8', HBROWSER_CONFIG_FILE: '/private/native.json' });
});

test('launch selects only the verified Firefox executable and cleans up on close', async () => {
  const files = await fixture();
  const fake = mockLauncher();
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot,
      headless: true, timeoutMs: 12345, proxy: { server: 'http://proxy.invalid:8080', username: 'user', password: 'DO_NOT_PRINT_SECRET' } }, fake);
    const [profilePath, options] = fake.launchedWith!;
    assert.equal(profilePath, browser.profile.path);
    assert.equal(options!.executablePath, join(files.install, 'camoufox-bin'));
    assert.equal(options!.headless, true);
    assert.equal(options!.timeout, 12345);
    assert.equal(options!.viewport, null);
    assert.equal(options!.handleSIGTERM, false);
    assert.equal(options!.proxy!.password, 'DO_NOT_PRINT_SECRET');
    const configPath = options!.env!.HBROWSER_CONFIG_FILE!;
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {});
    await Promise.all([browser.close(), browser.close(), browser.closed]);
    assert.equal(fake.closeCalls, 1);
    await assert.rejects(lstat(profilePath), { code: 'ENOENT' });
    await assert.rejects(lstat(configPath), { code: 'ENOENT' });
  } finally { await files.cleanup(); }
});

test('spontaneous window closure releases a named profile without deleting it', async () => {
  const files = await fixture();
  const fake = mockLauncher();
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot, profile: 'daily' }, fake);
    fake.events.emit('close');
    fake.exit();
    await browser.closed;
    assert.ok((await lstat(browser.profile.path)).isDirectory());
    assert.deepEqual(await listProfiles(files.profilesRoot), [{ name: 'daily', locked: false }]);
  } finally { await files.cleanup(); }
});

test('failed launches clean up temporary state without disclosing engine error credentials', async () => {
  const files = await fixture();
  const fake = mockLauncher({ failLaunch: true });
  try {
    await assert.rejects(launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot }, fake), error => {
      assert.doesNotMatch(String(error), /DO_NOT_PRINT_RUNTIME_SECRET|proxy\.invalid/);
      return (error as { code: string }).code === 'BROWSER_LAUNCH_FAILED';
    });
    await assert.rejects(lstat(fake.launchedWith![0]), { code: 'ENOENT' });
    await assert.rejects(lstat(fake.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!), { code: 'ENOENT' });
  } finally { await files.cleanup(); }
});

test('unconfirmed browser closure preserves its lock until a successful retry', async () => {
  const files = await fixture();
  const fake = mockLauncher({ failClose: true });
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot, profile: 'daily' }, fake);
    await assert.rejects(browser.close(), { code: 'BROWSER_CLOSE_FAILED' });
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'daily' }), { code: 'PROFILE_LOCKED' });
    fake.options.failClose = false;
    await browser.close();
    assert.deepEqual(await listProfiles(files.profilesRoot), [{ name: 'daily', locked: false }]);
  } finally { await files.cleanup(); }
});

test('a context close event before a failed process shutdown does not release the profile or private config', async () => {
  const files = await fixture();
  const fake = mockLauncher({ failCloseAfterEvent: true });
  let configPath: string | undefined;
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot, profile: 'still-exiting' }, fake);
    configPath = fake.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!;
    await assert.rejects(browser.close(), { code: 'BROWSER_CLOSE_FAILED' });
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'still-exiting' }), { code: 'PROFILE_LOCKED' });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {});
  } finally {
    if (configPath) await rm(dirname(configPath), { recursive: true, force: true });
    await files.cleanup();
  }
});

test('explicit cleanup joins the initial close and waits for late engine profile writes', async () => {
  const files = await fixture();
  const fake = mockLauncher({ holdExit: true });
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot }, fake);
    const closing = browser.close();
    const secondClose = browser.close();
    assert.equal(closing, secondClose);
    await fake.closeStarted;
    await writeFile(join(browser.profile.path, 'shutdown-state'), 'engine still writing');
    assert.ok((await lstat(join(browser.profile.path, '.hbrowser-lock'))).isDirectory());
    assert.deepEqual(JSON.parse(await readFile(fake.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!, 'utf8')), {});
    fake.exit();
    await Promise.all([closing, browser.closed]);
    await assert.rejects(lstat(browser.profile.path), { code: 'ENOENT' });
  } finally { fake.exit(); await files.cleanup(); }
});

test('spontaneous transport closure retains the profile until the observed process exits', async () => {
  const files = await fixture();
  const fake = mockLauncher({ holdExit: true });
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot }, fake);
    fake.events.emit('close');
    await writeFile(join(browser.profile.path, 'shutdown-state'), 'engine still writing');
    assert.ok((await lstat(join(browser.profile.path, '.hbrowser-lock'))).isDirectory());
    fake.exit();
    await browser.closed;
    await assert.rejects(lstat(browser.profile.path), { code: 'ENOENT' });
    assert.equal(fake.closeCalls, 0);
  } finally { fake.exit(); await files.cleanup(); }
});

test('launch never exposes an unidentified process and releases state only after confirmed recovery', async () => {
  const files = await fixture();
  let configPath: string | undefined;
  try {
    const explicit = mockLauncher({ noProcessIdentity: true });
    await assert.rejects(launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot }, explicit),
      { code: 'BROWSER_PROCESS_UNOBSERVED' });
    assert.equal(explicit.closeCalls, 1);
    await assert.rejects(lstat(explicit.launchedWith![0]), { code: 'ENOENT' });
    await assert.rejects(lstat(explicit.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!), { code: 'ENOENT' });
    const unconfirmed = mockLauncher({ noProcessIdentity: true, failClose: true });
    await assert.rejects(launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot, profile: 'unconfirmed' }, unconfirmed),
      { code: 'BROWSER_PROCESS_UNOBSERVED' });
    configPath = unconfirmed.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!;
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'unconfirmed' }), { code: 'PROFILE_LOCKED' });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {});
  } finally {
    if (configPath) await rm(dirname(configPath), { recursive: true, force: true });
    await files.cleanup();
  }
});

test('an unconfirmed observed process exit preserves the lock and native snapshot', async () => {
  const files = await fixture();
  const fake = mockLauncher({ failExit: true });
  let configPath: string | undefined;
  try {
    const browser = await launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot, profile: 'still-running' }, fake);
    configPath = fake.launchedWith![1]!.env!.HBROWSER_CONFIG_FILE!;
    fake.events.emit('close');
    await assert.rejects(browser.closed, { code: 'BROWSER_CLOSE_FAILED' });
    await assert.rejects(acquireProfile({ root: files.profilesRoot, name: 'still-running' }), { code: 'PROFILE_LOCKED' });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {});
  } finally {
    if (configPath) await rm(dirname(configPath), { recursive: true, force: true });
    await files.cleanup();
  }
});

test('integrity failure stops launch before the driver and invalid proxy settings remain private', async () => {
  const files = await fixture();
  const fake = mockLauncher();
  try {
    await writeFile(join(files.install, 'camoufox-bin'), 'tampered executable');
    await assert.rejects(launchHBrowser({ productDir: files.install, profilesRoot: files.profilesRoot }, fake), { code: 'INTEGRITY_MISMATCH' });
    assert.equal(fake.launchedWith, undefined);
    for (const server of ['http://user:DO_NOT_PRINT_SECRET@proxy.invalid:8080', 'file:///tmp/socket', 'http://proxy.invalid/path']) {
      assert.throws(() => validateProxy({ server }), error => {
        assert.doesNotMatch(String(error), /DO_NOT_PRINT_SECRET|proxy\.invalid/);
        return (error as { code: string }).code === 'INVALID_PROXY';
      });
    }
    assert.throws(() => validateProxy({ server: 'socks5://proxy.invalid:1080', username: 'user' }), { code: 'INVALID_PROXY' });
    await assert.rejects(launchHBrowser({ timeoutMs: 0 }), { code: 'INVALID_TIMEOUT' });
  } finally { await files.cleanup(); }
});

test('CLI doctor validates the supplied product and profiles list reports locks', async () => {
  const files = await fixture();
  try {
    const doctor = await runCli(['doctor'], { HB_PRODUCT_DIR: files.install });
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.deepEqual(JSON.parse(doctor.stdout), {
      product: 'HBrowser', version: files.manifest.version, platform: 'linux', arch: 'x64', engine: files.manifest.engine,
      verifiedFiles: 3, integrityVerified: true, browserLaunchValidated: false,
    });
    const profile = await acquireProfile({ root: files.profilesRoot, name: 'cli-user' });
    try {
      const profiles = await runCli(['profiles', 'list', '--profiles-root', files.profilesRoot]);
      assert.equal(profiles.code, 0, profiles.stderr);
      assert.deepEqual(JSON.parse(profiles.stdout), [{ name: 'cli-user', locked: true }]);
    } finally { await profile.release(); }
    await writeFile(join(files.install, 'libxul.so'), 'tampered');
    const corrupted = await runCli(['doctor', '--product-dir', files.install]);
    assert.equal(corrupted.code, 1);
    assert.match(corrupted.stderr, /INTEGRITY_MISMATCH/);
    assert.equal(corrupted.stdout, '');
  } finally { await files.cleanup(); }
});

test('CLI rejects missing product, invalid URLs and secret-bearing arguments without echoing values', async () => {
  const missing = await runCli(['doctor']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /PRODUCT_REQUIRED/);
  for (const args of [
    ['open', 'https://user:DO_NOT_PRINT_SECRET@example.invalid/'],
    ['open', '--unknown-DO_NOT_PRINT_SECRET'],
    ['open', 'file:///DO_NOT_PRINT_SECRET'],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_SECRET|example\.invalid/);
    assert.match(result.stderr, /INVALID_URL|INVALID_ARGUMENTS/);
  }
  const help = await runCli(['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /HBrowser — native browser product/);
});
