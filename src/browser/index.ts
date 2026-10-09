/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { firefox, type BrowserContext, type BrowserType } from 'playwright';
import { acquireProfile, type ProfileLease } from './profiles.js';
import { verifyProduct, type VerifiedProduct } from './manifest.js';
import { browserEnvironment, prepareNativeConfig, validateProxy, type BrowserProxy } from './config.js';
import { fail, HBrowserError } from './errors.js';
import { observeBrowserProcess } from './process.js';

export { verifyProduct, parseManifest } from './manifest.js';
export type { ProductManifest, ProductFile, VerifiedProduct } from './manifest.js';
export { acquireProfile, listProfiles, defaultProfilesRoot } from './profiles.js';
export type { ProfileLease, ProfileSummary } from './profiles.js';
export { HBrowserError } from './errors.js';
export type { BrowserProxy } from './config.js';
export { inspectCapabilities } from './capabilities.js';
export { inspectEnvironment, inventoryFonts } from './environment.js';

export interface HBrowserOptions {
  productDir?: string;
  profile?: string;
  profilesRoot?: string;
  headless?: boolean;
  configPath?: string;
  proxy?: BrowserProxy;
  timeoutMs?: number;
  /** Actual Firefox headless screen dimensions, never a navigator/screen script override. */
  headlessScreen?: { width: number; height: number };
}
export interface HBrowser {
  context: BrowserContext;
  product: VerifiedProduct;
  profile: Pick<ProfileLease, 'path' | 'name' | 'temporary'>;
  /** Resolves after confirmed engine exit and cleanup; rejects if exit cannot be confirmed. */
  closed: Promise<void>;
  close(): Promise<void>;
}
export interface BrowserDependencies {
  launcher?: Pick<BrowserType, 'launchPersistentContext'>;
  processObserver?: typeof observeBrowserProcess;
}

/** Always runs the verified HBrowser executable through Firefox's Playwright transport. No fallback browser. */
export async function launchHBrowser(options: HBrowserOptions = {}, dependencies: BrowserDependencies = {}): Promise<HBrowser> {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) fail('INVALID_TIMEOUT', 'Browser timeout must be an integer from 1 to 300000 milliseconds.');
  const proxy = validateProxy(options.proxy);
  const screen = options.headlessScreen;
  if (screen && (options.headless !== true || ![screen.width, screen.height].every(n => Number.isInteger(n) && n >= 128 && n <= 8192))) fail('INVALID_SCREEN', 'Headless screen dimensions require headless mode and integers from 128 to 8192.');
  const product = await verifyProduct(options.productDir);
  const native = await prepareNativeConfig(options.configPath);
  let profile: ProfileLease;
  try { profile = await acquireProfile({ root: options.profilesRoot, name: options.profile }); }
  catch (error) { await native.cleanup(); throw error; }
  let context: BrowserContext;
  try {
    context = await (dependencies.launcher ?? firefox).launchPersistentContext(profile.path, {
      executablePath: product.executablePath, headless: options.headless ?? false,
      timeout, env: { ...browserEnvironment(native.path), ...(screen ? { MOZ_HEADLESS_WIDTH: String(screen.width), MOZ_HEADLESS_HEIGHT: String(screen.height) } : {}) }, viewport: null,
      ...(proxy ? { proxy } : {}), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
  } catch {
    await Promise.all([profile.release(), native.cleanup()]);
    fail('BROWSER_LAUNCH_FAILED', 'HBrowser failed to launch. Check installation compatibility, desktop display and launch timeout.');
  }
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Consumers may use close() alone without awaiting spontaneous closure.
  void closed.catch(() => {});
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= Promise.all([profile.release(), native.cleanup()]).then(() => resolveClosed(), error => {
      const safeError = error instanceof HBrowserError ? error : new HBrowserError('CLEANUP_FAILED', 'HBrowser closed but temporary file cleanup failed.');
      rejectClosed(safeError);
      throw safeError;
    });
    return cleanupPromise;
  };
  // Firefox's transport EOF precedes process exit and final profile writes.
  // Capture the owned process while it is alive; never identify it after EOF.
  const observedProcess = (dependencies.processObserver ?? observeBrowserProcess)({
    executablePath: product.executablePath, profilePath: profile.path, timeoutMs: timeout,
  }).catch(() => undefined);
  let closeEventObserved = false;
  let explicitCloseRequested = false;
  let closing: Promise<void> | undefined;
  let spontaneousClosing: Promise<void> | undefined;
  const closeFailure = () => new HBrowserError('BROWSER_CLOSE_FAILED', 'Browser process exit could not be confirmed; its profile lock and private configuration were preserved.');
  const onContextClosed = () => {
    closeEventObserved = true;
    if (explicitCloseRequested) return;
    spontaneousClosing ??= (async () => {
      const barrier = await observedProcess;
      if (!barrier) throw closeFailure();
      try { await barrier.waitForExit(); }
      catch { throw closeFailure(); }
      await cleanup();
    })();
    void spontaneousClosing.catch(rejectClosed);
  };
  context.once('close', onContextClosed);
  if (context.isClosed()) onContextClosed();
  const processBarrier = await observedProcess;
  if (!processBarrier) {
    // No caller has received the context yet, so this can own the first close
    // request. Once a context is public, its close/disconnect events alone are
    // insufficient proof of process exit.
    explicitCloseRequested = true;
    const alreadyClosed = closeEventObserved || context.isClosed();
    let closureConfirmed = false;
    try {
      await context.close();
      closureConfirmed = !alreadyClosed;
    } catch { /* Preserve resources when recovery cannot confirm shutdown. */ }
    if (closureConfirmed) await cleanup();
    fail('BROWSER_PROCESS_UNOBSERVED', 'HBrowser process identity could not be verified; startup was stopped. Resources are preserved if shutdown could not be confirmed.');
  }
  return {
    context, product, profile: { path: profile.path, name: profile.name, temporary: profile.temporary }, closed,
    close() {
      if (cleanupPromise) return cleanupPromise;
      if (spontaneousClosing) return spontaneousClosing;
      if (closing) return closing;
      // Set this before invoking close(): a test double or driver may emit close
      // synchronously. All callers must join the FIRST request, not a later
      // context.close() that returns immediately because the context is closed.
      explicitCloseRequested = true;
      closing = (async () => {
        try {
          await context.close();
          await processBarrier.waitForExit();
        } catch {
          throw closeFailure();
        }
        await cleanup();
      })().catch(error => {
        closing = undefined;
        explicitCloseRequested = false;
        if (closeEventObserved) rejectClosed(error);
        throw error;
      });
      return closing;
    },
  };
}
