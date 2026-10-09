/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Page } from 'playwright';

/** Actual Fontconfig family inventory; no raw paths or OS environment dump. */
export async function inventoryFonts() {
  try {
    const { stdout } = await promisify(execFile)('fc-list', ['--format', '%{family}\n'], { timeout: 5000, maxBuffer: 1024 * 1024, env: process.env });
    const families = [...new Set(stdout.split('\n').filter(Boolean))].sort();
    return { status: 'observed' as const, families, count: families.length, sha256: createHash('sha256').update(JSON.stringify(families)).digest('hex'), scope: 'host_fontconfig_not_browser_font_availability' };
  } catch { return { status: 'unavailable' as const, families: null, count: null, sha256: null, scope: 'host_fontconfig_not_browser_font_availability' }; }
}

/** Read only, for an owned diagnostic fixture. Measures the environment actually used. */
export async function inspectEnvironment(page: Page, timeoutMs = 5000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid environment inspection timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([page.evaluate(async () => {
      await document.fonts.ready;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const samples = ['HBrowser café Ω Ж', '漢字', '🙂'];
      const fontMetrics = ['serif', 'sans-serif', 'monospace', 'HBrowserMissingFontFixture, monospace'].map(family => {
        if (context) context.font = `16px ${family}`;
        return { family, measuredWidths: samples.map(text => context ? context.measureText(text).width : null) };
      });
      return {
        schemaVersion: 1, userAgent: navigator.userAgent, platform: navigator.platform,
        languages: [...navigator.languages], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
        window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
        media: { dark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, moreContrast: matchMedia('(prefers-contrast: more)').matches },
        fonts: { status: document.fonts.status, metrics: fontMetrics, coverage: 'not_proven_by_width_or_fonts_check' },
        interpretation: 'observed_environment_no_anti_bot_score',
      };
    }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Environment inspection timeout')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
