/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page } from 'playwright';
import { HBrowserError } from './errors.js';

/** Functional availability, not a fingerprint, bot verdict or permission grant.
 * Does not request permissions, enumerate devices/fonts, read cookies, or hash rendering.
 */
export async function inspectCapabilities(page: Page, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new HBrowserError('INVALID_TIMEOUT', 'Capability inspection timeout must be between 1 and 120000 milliseconds.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HBrowserError('INSPECTION_TIMEOUT', 'Capability inspection timed out.')), timeoutMs);
  });
  try { return await Promise.race([page.evaluate(() => ({
    secureContext: isSecureContext,
    javascript: true,
    canvas2d: !!document.createElement('canvas').getContext('2d'),
    webglApi: typeof WebGLRenderingContext !== 'undefined',
    worker: typeof Worker !== 'undefined',
    sharedWorker: typeof SharedWorker !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    indexedDB: typeof indexedDB !== 'undefined',
    webSocket: typeof WebSocket !== 'undefined',
    webRTC: typeof RTCPeerConnection !== 'undefined',
    mediaDevices: !!navigator.mediaDevices,
    permissions: 'permissions' in navigator,
    notifications: typeof Notification !== 'undefined',
    notificationPermission: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
    fileInput: 'files' in document.createElement('input'),
    reducedMotionQuery: matchMedia('(prefers-reduced-motion)').media !== 'not all',
    contrastQuery: matchMedia('(prefers-contrast)').media !== 'not all',
    webMCP: (() => {
      const c = (document as Document & { modelContext?: { getTools?: unknown; executeTool?: unknown } }).modelContext;
      return !!c && typeof c.getTools === 'function' && typeof c.executeTool === 'function';
    })(),
  })), timed]); }
  finally { clearTimeout(timer); }
}
