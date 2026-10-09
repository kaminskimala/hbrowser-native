/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, HBrowserError } from './errors.js';

export interface BrowserExitBarrier { waitForExit(): Promise<void> }
export interface BrowserProcessDependencies {
  platform: string;
  parentPid: number;
  readFile(path: string): Promise<string>;
  readDirectory(path: string): Promise<string[]>;
  readLink(path: string): Promise<string>;
  realPath(path: string): Promise<string>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const defaults: BrowserProcessDependencies = {
  platform: process.platform,
  parentPid: process.pid,
  readFile: path => readFile(path, 'utf8'),
  readDirectory: path => readdir(path),
  readLink: path => readlink(path),
  realPath: path => realpath(path),
  now: () => performance.now(),
  sleep: milliseconds => delay(milliseconds),
};

interface Identity { pid: number; parentPid: number; startTime: string; state: string }
const absent = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException)?.code ?? '');
const stopped = (state: string) => state === 'Z' || state === 'X' || state === 'x';
const observationFailed = (): never => fail('PROCESS_OBSERVATION_FAILED', 'HBrowser process identity or exit could not be verified.');

function parseStat(value: string, expectedPid: number): Identity {
  // comm is parenthesized but may itself contain spaces or closing parentheses.
  const prefix = value.match(/^(\d+) \(/);
  const end = value.lastIndexOf(')');
  const fields = value.slice(end + 1).trim().split(/\s+/);
  if (!prefix || Number(prefix[1]) !== expectedPid || end < prefix[0].length
    || fields.length < 20 || !/^[RSDZTtXxKWPI]$/.test(fields[0] ?? '')
    || !/^\d+$/.test(fields[1] ?? '') || !/^\d+$/.test(fields[19] ?? '')) observationFailed();
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid)) observationFailed();
  return { pid: expectedPid, parentPid, startTime: BigInt(fields[19]!).toString(), state: fields[0]! };
}

/** Observe only this Node process's direct children; never enumerate other process argv. */
export async function observeBrowserProcess(
  options: { executablePath: string; profilePath: string; timeoutMs: number },
  injection: Partial<BrowserProcessDependencies> = {},
): Promise<BrowserExitBarrier> {
  const io = { ...defaults, ...injection };
  if (io.platform !== 'linux') fail('PROCESS_OBSERVATION_UNSUPPORTED', 'HBrowser process supervision requires Linux.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    fail('INVALID_TIMEOUT', 'Browser timeout must be an integer from 1 to 300000 milliseconds.');
  }
  const stat = async (pid: number) => parseStat(await io.readFile(`/proc/${pid}/stat`), pid);
  const capture = async (pid: number, executable: string): Promise<Identity | undefined> => {
    let before: Identity;
    try { before = await stat(pid); }
    catch (error) { if (absent(error)) return; throw error; }
    if (before.parentPid !== io.parentPid || stopped(before.state)) return;
    try {
      const argv = (await io.readFile(`/proc/${pid}/cmdline`)).split('\0');
      const flag = argv.indexOf('-profile');
      if (flag < 0 || flag !== argv.lastIndexOf('-profile') || argv[flag + 1] !== options.profilePath) return;
      if (await io.readLink(`/proc/${pid}/exe`) !== executable) return;
      const after = await stat(pid);
      if (before.startTime !== after.startTime || after.parentPid !== io.parentPid || stopped(after.state)) return;
      return after;
    } catch (error) {
      if (absent(error)) {
        try { if (stopped((await stat(pid)).state)) return; }
        catch (again) { if (absent(again)) return; throw again; }
      }
      throw error;
    }
  };

  let identity: Identity;
  try {
    const executable = await io.realPath(options.executablePath);
    const children = new Set<number>();
    for (const tid of await io.readDirectory('/proc/self/task')) {
      if (!/^[1-9]\d*$/.test(tid)) observationFailed();
      const contents = (await io.readFile(`/proc/self/task/${tid}/children`)).trim();
      if (!contents) continue;
      for (const value of contents.split(/\s+/)) {
        const pid = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid)) observationFailed();
        children.add(pid);
      }
    }
    const matches: Identity[] = [];
    for (const pid of children) {
      const candidate = await capture(pid, executable);
      if (candidate) matches.push(candidate);
    }
    if (!matches.length) fail('BROWSER_PROCESS_NOT_FOUND', 'The launched HBrowser process could not be identified.');
    if (matches.length !== 1) fail('BROWSER_PROCESS_AMBIGUOUS', 'More than one HBrowser process matches this session.');
    identity = matches[0]!;
  } catch (error) {
    if (error instanceof HBrowserError) throw error;
    observationFailed();
  }

  let waiting: Promise<void> | undefined;
  const wait = async () => {
    const deadline = io.now() + options.timeoutMs;
    while (true) {
      let current: Identity;
      try { current = await stat(identity.pid); }
      catch (error) { if (absent(error)) return; return observationFailed(); }
      if (current.startTime !== identity.startTime || stopped(current.state)) return;
      const remaining = deadline - io.now();
      if (remaining <= 0) fail('BROWSER_EXIT_TIMEOUT', 'HBrowser process exit was not confirmed before the timeout.');
      await io.sleep(Math.min(50, remaining));
    }
  };
  return {
    waitForExit() {
      waiting ??= wait().catch(error => {
        waiting = undefined;
        if (error instanceof HBrowserError) throw error;
        observationFailed();
      });
      return waiting;
    },
  };
}
