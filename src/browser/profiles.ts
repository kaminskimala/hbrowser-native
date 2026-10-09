/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, HBrowserError } from './errors.js';

export interface ProfileLease { path: string; name?: string; temporary: boolean; release(): Promise<void> }
export interface ProfileSummary { name: string; locked: boolean }
export function defaultProfilesRoot(): string { return join(homedir(), '.local', 'share', 'hbrowser', 'profiles'); }
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);

async function rootDirectory(root: string, create: boolean): Promise<string> {
  const path = resolve(root);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) {
    fail('INVALID_PROFILE_ROOT', 'Profiles root must be a private directory owned by the current user (mode 0700).');
  }
  return realpath(path);
}

export async function acquireProfile(options: { root?: string; name?: string } = {}): Promise<ProfileLease> {
  if (options.name !== undefined && !validName(options.name)) fail('INVALID_PROFILE_NAME', 'Profile names use 1–64 letters, digits, underscores or hyphens and start with a letter or digit.');
  let path: string | undefined;
  let temporary = false;
  try {
    const root = await rootDirectory(options.root ?? defaultProfilesRoot(), true);
    temporary = options.name === undefined;
    if (temporary) path = await mkdtemp(join(root, '.temporary-'));
    else {
      path = join(root, options.name!);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const profilePath = path;
    const profileStat = await lstat(profilePath);
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || (profileStat.mode & 0o077) !== 0 ||
      (process.getuid && profileStat.uid !== process.getuid())) fail('INVALID_PROFILE', 'Profile must be a private regular directory owned by the current user.');
    const lockPath = join(profilePath, '.hbrowser-lock');
    try { await mkdir(lockPath, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('PROFILE_LOCKED', 'Profile is locked. Close its browser; after a crash, inspect the lock before manually removing it.');
      throw error;
    }
    const token = randomUUID();
    const ownerPath = join(lockPath, 'owner.json');
    try { await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rmdir(lockPath).catch(() => {}); throw error; }
    let released = false;
    let releasing: Promise<void> | undefined;
    return {
      path: profilePath, name: options.name, temporary,
      release() {
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        releasing = (async () => {
          const current = await lstat(profilePath);
          const lock = await lstat(lockPath);
          const owner = await lstat(ownerPath);
          if (!current.isDirectory() || current.ino !== profileStat.ino || current.dev !== profileStat.dev ||
            !lock.isDirectory() || lock.isSymbolicLink() || !owner.isFile() || owner.isSymbolicLink() ||
            JSON.parse(await readFile(ownerPath, 'utf8')).token !== token) {
            fail('PROFILE_OWNERSHIP_CHANGED', 'Profile ownership changed; cleanup was stopped to preserve files.');
          }
          await unlink(ownerPath);
          await rmdir(lockPath);
          if (temporary) await rm(profilePath, { recursive: true, force: true });
          released = true;
        })().catch(error => {
          releasing = undefined;
          if (error instanceof HBrowserError) throw error;
          fail('PROFILE_CLEANUP_FAILED', 'Unable to release the browser profile; its files have been preserved.');
        });
        return releasing;
      },
    };
  } catch (error) {
    if (temporary && path) await rm(path, { recursive: true, force: true }).catch(() => {});
    if (error instanceof HBrowserError) throw error;
    fail('PROFILE_UNAVAILABLE', 'Unable to acquire a private HBrowser profile.');
  }
}

export async function listProfiles(root = defaultProfilesRoot()): Promise<ProfileSummary[]> {
  try {
    const directory = await rootDirectory(root, false);
    const result: ProfileSummary[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validName(entry.name)) continue;
      let locked = true;
      try { await lstat(join(directory, entry.name, '.hbrowser-lock')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') locked = false; else throw error; }
      result.push({ name: entry.name, locked });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof HBrowserError) throw error;
    fail('PROFILE_UNAVAILABLE', 'Unable to list HBrowser profiles.');
  }
}
