/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBrowserProcess, type BrowserProcessDependencies } from '../src/browser/process.js';

const executablePath = '/verified/camoufox-bin';
const profilePath = '/private/profile';
const options = { executablePath, profilePath, timeoutMs: 100 };
const missing = () => Object.assign(new Error('DO_NOT_PRINT_PRIVATE_PATH'), { code: 'ENOENT' });

function processStat(pid = 42, start = '123', state = 'S', parent = 7) {
  const fields = [state, String(parent), ...Array<string>(17).fill('0'), start, '0'];
  return `${pid} (firefox ) child (name)) ${fields.join(' ')}`;
}

function fixture() {
  const files = new Map<string, string>([
    ['/proc/self/task/7/children', '42'],
    ['/proc/self/task/8/children', '42'],
    ['/proc/42/stat', processStat()],
    ['/proc/42/cmdline', `${executablePath}\0-no-remote\0-profile\0${profilePath}\0`],
  ]);
  const links = new Map([['/proc/42/exe', executablePath]]);
  const failures = new Map<string, string>();
  const reads: string[] = [];
  let elapsed = 0;
  let onSleep = () => {};
  const io: BrowserProcessDependencies = {
    platform: 'linux', parentPid: 7,
    async readFile(path) {
      reads.push(path);
      if (failures.has(path)) throw Object.assign(new Error('DO_NOT_PRINT_PRIVATE_PATH'), { code: failures.get(path) });
      const value = files.get(path);
      if (value === undefined) throw missing();
      return value;
    },
    async readDirectory(path) { assert.equal(path, '/proc/self/task'); return ['7', '8']; },
    async readLink(path) { const value = links.get(path); if (!value) throw missing(); return value; },
    async realPath(path) { assert.equal(path, executablePath); return executablePath; },
    now: () => elapsed,
    async sleep(milliseconds) { elapsed += milliseconds; onSleep(); },
  };
  return { files, links, failures, reads, io, get elapsed() { return elapsed; }, set onSleep(callback: () => void) { onSleep = callback; } };
}

test('process observer unions direct-child lists and waits until the identified process disappears', async () => {
  const f = fixture();
  const barrier = await observeBrowserProcess(options, f.io);
  f.onSleep = () => { f.files.delete('/proc/42/stat'); };
  const first = barrier.waitForExit();
  assert.equal(barrier.waitForExit(), first);
  await first;
  assert.equal(f.elapsed, 50);
  assert.equal(f.reads.filter(path => path === '/proc/42/cmdline').length, 1);
  assert.ok(f.reads.every(path => /^\/proc\/(?:self\/task\/[78]\/children|42\/(?:cmdline|stat))$/.test(path)));
});

test('process observer recognizes PID reuse from starttime without waiting on the replacement', async () => {
  const f = fixture();
  f.files.set('/proc/42/stat', processStat(42, '9007199254740992'));
  const barrier = await observeBrowserProcess(options, f.io);
  f.files.set('/proc/42/stat', processStat(42, '9007199254740993'));
  await barrier.waitForExit();
  assert.equal(f.elapsed, 0);
});

test('process observer accepts proven zombie and dead states but waits on a stopped process', async () => {
  for (const state of ['Z', 'X', 'x']) {
    const f = fixture();
    const barrier = await observeBrowserProcess(options, f.io);
    f.files.set('/proc/42/stat', processStat(42, '123', state));
    await barrier.waitForExit();
    assert.equal(f.elapsed, 0);
  }
  const f = fixture();
  const barrier = await observeBrowserProcess(options, f.io);
  f.files.set('/proc/42/stat', processStat(42, '123', 'T'));
  await assert.rejects(barrier.waitForExit(), { code: 'BROWSER_EXIT_TIMEOUT' });
});

test('exit timeout is bounded from the wait call and permits later confirmation', async () => {
  const f = fixture();
  const barrier = await observeBrowserProcess(options, f.io);
  await f.io.sleep(10_000);
  await assert.rejects(barrier.waitForExit(), { code: 'BROWSER_EXIT_TIMEOUT' });
  assert.equal(f.elapsed, 10_100);
  f.files.delete('/proc/42/stat');
  await barrier.waitForExit();
});

test('process identification rejects ambiguous matches', async () => {
  const f = fixture();
  f.files.set('/proc/self/task/8/children', '42 43');
  f.files.set('/proc/43/stat', processStat(43));
  f.files.set('/proc/43/cmdline', f.files.get('/proc/42/cmdline')!);
  f.links.set('/proc/43/exe', executablePath);
  await assert.rejects(observeBrowserProcess(options, f.io), { code: 'BROWSER_PROCESS_AMBIGUOUS' });
});

test('process identification requires the exact executable, profile argument, and parent', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.links.set('/proc/42/exe', '/other/camoufox-bin'); },
    (f: ReturnType<typeof fixture>) => { f.files.set('/proc/42/cmdline', `${executablePath}\0-profile\0${profilePath}-other\0`); },
    (f: ReturnType<typeof fixture>) => { f.files.set('/proc/42/cmdline', `${executablePath}\0-profile=${profilePath}\0`); },
    (f: ReturnType<typeof fixture>) => { f.files.set('/proc/42/cmdline', `${executablePath}\0-profile\0${profilePath}\0-profile\0${profilePath}\0`); },
    (f: ReturnType<typeof fixture>) => { f.files.set('/proc/42/stat', processStat(42, '123', 'S', 8)); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(observeBrowserProcess(options, f.io), { code: 'BROWSER_PROCESS_NOT_FOUND' });
  }
});

test('process identification refuses identity changes or disappearance during capture', async () => {
  for (const replacement of [undefined, processStat(42, '456'), processStat(42, '123', 'S', 8)]) {
    const f = fixture();
    const readLink = f.io.readLink;
    f.io.readLink = async path => {
      if (replacement === undefined) f.files.delete('/proc/42/stat');
      else f.files.set('/proc/42/stat', replacement);
      return readLink(path);
    };
    await assert.rejects(observeBrowserProcess(options, f.io), { code: 'BROWSER_PROCESS_NOT_FOUND' });
  }
});

test('process read failures are rejected without disclosing arguments or private paths', async () => {
  const f = fixture();
  f.io.readLink = async () => { throw Object.assign(new Error('DO_NOT_PRINT_PRIVATE_PATH'), { code: 'EACCES' }); };
  await assert.rejects(observeBrowserProcess(options, f.io), error => {
    assert.doesNotMatch(String(error), /DO_NOT_PRINT/);
    return (error as { code: string }).code === 'PROCESS_OBSERVATION_FAILED';
  });
  const g = fixture();
  const barrier = await observeBrowserProcess(options, g.io);
  g.failures.set('/proc/42/stat', 'EACCES');
  await assert.rejects(barrier.waitForExit(), error => {
    assert.doesNotMatch(String(error), /DO_NOT_PRINT/);
    return (error as { code: string }).code === 'PROCESS_OBSERVATION_FAILED';
  });
});

test('process identification rejects missing processes and malformed proc metadata', async () => {
  const f = fixture(); f.files.delete('/proc/42/stat');
  await assert.rejects(observeBrowserProcess(options, f.io), { code: 'BROWSER_PROCESS_NOT_FOUND' });
  for (const [path, value] of [['/proc/42/stat', '42 (broken) S'], ['/proc/self/task/7/children', '42 bad']]) {
    const g = fixture(); g.files.set(path!, value!);
    await assert.rejects(observeBrowserProcess(options, g.io), { code: 'PROCESS_OBSERVATION_FAILED' });
  }
});

test('process supervision rejects unsupported platforms and invalid timeouts', async () => {
  await assert.rejects(observeBrowserProcess(options, { ...fixture().io, platform: 'darwin' }), { code: 'PROCESS_OBSERVATION_UNSUPPORTED' });
  for (const timeoutMs of [0, -1, 0.5, Infinity, 300_001]) {
    await assert.rejects(observeBrowserProcess({ ...options, timeoutMs }, fixture().io), { code: 'INVALID_TIMEOUT' });
  }
});
