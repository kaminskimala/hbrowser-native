/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { inspectCapabilities } from '../src/browser/capabilities.js';

test('capability inspection cannot hang on an unresponsive page', async () => {
  const page = { evaluate: () => new Promise(() => {}) } as unknown as Page;
  await assert.rejects(inspectCapabilities(page, { timeoutMs: 15 }), { code: 'INSPECTION_TIMEOUT' });
  await assert.rejects(inspectCapabilities(page, { timeoutMs: NaN }), { code: 'INVALID_TIMEOUT' });
});
