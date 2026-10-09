/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { constants } from 'node:fs';
import { access, lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fail, HBrowserError } from './errors.js';

export interface ProductFile { path: string; sha256: string }
export interface ProductManifest {
  schemaVersion: 1;
  product: 'HBrowser';
  version: string;
  platform: 'linux';
  arch: 'x64';
  engine: { name: 'camoufox'; revision: string; firefoxVersion: string };
  executable: string;
  files: ProductFile[];
  patches: ProductFile[];
}
export interface VerifiedProduct { directory: string; executablePath: string; manifest: ProductManifest }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    !/[\\\x00-\x1f:]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function entries(value: unknown): value is ProductFile[] {
  return Array.isArray(value) && value.length > 0 && value.every(entry => object(entry) && validPath(entry.path) &&
    entry.path !== 'hbrowser-build.json' && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256));
}

export function parseManifest(value: unknown): ProductManifest {
  if (!object(value) || value.schemaVersion !== 1 || value.product !== 'HBrowser' ||
    typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
    value.platform !== 'linux' || value.arch !== 'x64' || !object(value.engine) || value.engine.name !== 'camoufox' ||
    typeof value.engine.revision !== 'string' || !/^[0-9a-f]{40}$/.test(value.engine.revision) ||
    typeof value.engine.firefoxVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[a-z]\d+)?$/.test(value.engine.firefoxVersion) ||
    !validPath(value.executable) || !entries(value.files) || !entries(value.patches)) {
    fail('INVALID_MANIFEST', 'Invalid HBrowser build manifest. Install a packaged HBrowser build.');
  }
  const manifest = value as unknown as ProductManifest;
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]));
  if (files.size !== manifest.files.length || !files.has(manifest.executable) || !files.has('libxul.so') ||
    new Set(manifest.patches.map(file => file.path)).size !== manifest.patches.length ||
    !manifest.patches.every(file => file.path.startsWith('provenance/patches/') && files.get(file.path) === file.sha256)) {
    fail('INVALID_MANIFEST', 'HBrowser manifest must cover its executable, libxul.so and unique native patches.');
  }
  return manifest;
}

async function regularFile(root: string, relative: string): Promise<string> {
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      fail('INVALID_INSTALLATION', 'HBrowser package paths must be regular files and directories without symbolic links.');
    }
  }
  return current;
}

async function inventory(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (!validPath(path) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
      fail('INVALID_INSTALLATION', 'HBrowser installation contains an unsupported file or symbolic link.');
    }
    if (item.isDirectory()) result.push(...await inventory(root, path));
    else if (path !== 'hbrowser-build.json') result.push(path);
  }
  return result;
}

/** Integrity checking is local provenance checking; a manifest is not a publisher signature. */
export async function verifyProduct(productDir = process.env.HB_PRODUCT_DIR): Promise<VerifiedProduct> {
  if (!productDir?.trim()) fail('PRODUCT_REQUIRED', 'Set HB_PRODUCT_DIR or provide productDir for your packaged HBrowser installation.');
  try {
    const requested = resolve(productDir);
    const rootStat = await lstat(requested);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('INVALID_INSTALLATION', 'HBrowser installation must be a directory, not a symbolic link.');
    const directory = await realpath(requested);
    const manifestPath = await regularFile(directory, 'hbrowser-build.json');
    const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let manifest: ProductManifest;
    try {
      const maximum = 4 * 1024 * 1024;
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum) fail('INVALID_MANIFEST', 'HBrowser manifest must be a regular file within the size limit.');
      const data = Buffer.alloc(maximum + 1);
      let count = 0;
      while (count < data.length) {
        const { bytesRead } = await handle.read(data, count, data.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > maximum) fail('INVALID_MANIFEST', 'HBrowser manifest exceeds the size limit.');
      manifest = parseManifest(JSON.parse(data.subarray(0, count).toString('utf8')));
    } finally { await handle.close(); }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      fail('UNSUPPORTED_PLATFORM', 'This HBrowser package supports Linux x64 only.');
    }
    const paths = await inventory(directory);
    const declared = new Set(manifest.files.map(file => file.path));
    if (paths.length !== declared.size || paths.some(path => !declared.has(path))) {
      fail('INVALID_INSTALLATION', 'HBrowser package contains missing or unlisted files.');
    }
    // Stream large engine files: libxul.so need not fit into JavaScript memory.
    for (const file of manifest.files) {
      const path = await regularFile(directory, file.path);
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await input.stat()).isFile()) fail('INVALID_INSTALLATION', 'HBrowser package contains a non-regular file.');
        const hash = createHash('sha256');
        for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== file.sha256) fail('INTEGRITY_MISMATCH', 'HBrowser package integrity check failed. Reinstall the verified build.');
      } finally { await input.close(); }
    }
    const executablePath = join(directory, manifest.executable);
    await access(executablePath, constants.X_OK);
    return { directory, executablePath, manifest };
  } catch (error) {
    if (error instanceof HBrowserError) throw error;
    fail('INVALID_INSTALLATION', 'Unable to read or validate the HBrowser installation.');
  }
}
