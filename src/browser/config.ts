/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserType } from 'playwright';
import { fail, HBrowserError } from './errors.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const SERVER_CREDENTIAL_KEY = /secret|hcaptcha|api[_-]?key|access[_-]?token|password/i;
export type BrowserProxy = NonNullable<NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>['proxy']>;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function readPrivateDocument(path: string): Promise<{
  value: Record<string, unknown>; text: string; hasServerCredentialKeys: boolean;
}> {
  try {
    const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o7777) ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_CONFIG_BYTES) {
        fail('INVALID_CONFIG', 'Configuration must be a private regular JSON file (mode 0600 or 0400), at most 1 MiB.');
      }
      const data = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let count = 0;
      while (count < data.length) {
        const { bytesRead } = await handle.read(data, count, data.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > MAX_CONFIG_BYTES) fail('INVALID_CONFIG', 'Configuration exceeds the 1 MiB limit.');
      // Decode strictly and validate syntax before examining scalar tokens.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, count));
      const value: unknown = JSON.parse(text);
      if (!object(value)) fail('INVALID_CONFIG', 'Configuration must be a JSON object.');
      let hasServerCredentialKeys = false;
      // A reviver cannot inspect overwritten duplicate members. These disjoint
      // token alternatives examine every string/number in already-valid JSON,
      // including keys. Keep the original text so native int64 values never
      // pass through JavaScript's lossy number serialization.
      for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
        const token = match[0];
        if (token.startsWith('"')) {
          const string: string = JSON.parse(token);
          for (const character of string) {
            const point = character.codePointAt(0)!;
            if (point >= 0xd800 && point <= 0xdfff) {
              fail('INVALID_CONFIG', 'Configuration strings must contain valid Unicode scalar values.');
            }
          }
          let next = match.index + token.length;
          while (/[\x20\t\r\n]/.test(text[next] ?? '')) next++;
          if (text[next] === ':' && SERVER_CREDENTIAL_KEY.test(string)) hasServerCredentialKeys = true;
        } else if (!Number.isFinite(Number(token))) {
          fail('INVALID_CONFIG', 'Configuration numbers must be finite.');
        }
      }
      return { value, text, hasServerCredentialKeys };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof HBrowserError) throw error;
    fail('INVALID_CONFIG', 'Unable to read private JSON configuration; check its format and file permissions.');
  }
}

export async function readPrivateJson(path: string): Promise<Record<string, unknown>> {
  return (await readPrivateDocument(path)).value;
}

/** Snapshot the caller's config so a long-lived browser never reads mutable user input. */
export async function prepareNativeConfig(configPath?: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  const document = configPath ? await readPrivateDocument(configPath) : { text: '{}', hasServerCredentialKeys: false };
  if (document.hasServerCredentialKeys) {
    fail('SERVER_CREDENTIAL_IN_CONFIG', 'Native browser configuration must not contain server credentials. Use proxy configuration for proxy authentication.');
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'hbrowser-config-'));
    const privateDirectory = directory;
    const path = join(privateDirectory, 'native.json');
    await writeFile(path, document.text, { flag: 'wx', mode: 0o600 });
    return { path, cleanup: () => rm(privateDirectory, { recursive: true, force: true }) };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    fail('INVALID_CONFIG', 'Unable to create a private native configuration snapshot.');
  }
}

export function validateProxy(value: unknown): BrowserProxy | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || typeof value.server !== 'string' ||
    Object.keys(value).some(key => !['server', 'username', 'password', 'bypass'].includes(key)) ||
    ['username', 'password', 'bypass'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    fail('INVALID_PROXY', 'Proxy configuration requires server and optional username, password and bypass strings.');
  }
  try {
    const parsed = new URL(value.server);
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password ||
      parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash || /[\s\x00-\x1f]/.test(value.server)) throw new Error();
    if (parsed.protocol === 'socks5:' && (value.username !== undefined || value.password !== undefined)) {
      fail('INVALID_PROXY', 'Authenticated SOCKS5 proxies are not supported by the Firefox driver.');
    }
  } catch (error) {
    if (error instanceof HBrowserError) throw error;
    fail('INVALID_PROXY', 'Proxy server must be an HTTP, HTTPS or SOCKS5 origin with credentials in separate fields.');
  }
  return { server: value.server, ...(value.username !== undefined ? { username: value.username as string } : {}),
    ...(value.password !== undefined ? { password: value.password as string } : {}),
    ...(value.bypass !== undefined ? { bypass: value.bypass as string } : {}) };
}

/** Only OS/desktop settings enter the engine process. Service credentials and Camoufox overrides do not. */
export function browserEnvironment(configPath: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = /^(?:HOME|PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|DBUS_SESSION_BUS_ADDRESS|PULSE_SERVER|TMPDIR)$/;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (allowed.test(key) && value !== undefined) env[key] = value;
  env.HBROWSER_CONFIG_FILE = configPath;
  return env;
}
