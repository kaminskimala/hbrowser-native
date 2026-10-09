/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Public errors contain setting names and fixed text, never runtime paths, URLs or credentials. */
export class HBrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HBrowserError';
  }
}

export function fail(code: string, message: string): never { throw new HBrowserError(code, message); }
