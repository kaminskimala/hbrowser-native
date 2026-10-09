#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { launchHBrowser, listProfiles, verifyProduct, inspectCapabilities, inspectEnvironment, inventoryFonts, HBrowserError, type HBrowser } from './index.js';
import { readPrivateJson, validateProxy } from './config.js';

function parseArguments(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: {
      'product-dir': { type: 'string' }, 'profiles-root': { type: 'string' }, profile: { type: 'string' },
      config: { type: 'string' }, 'proxy-config': { type: 'string' }, timeout: { type: 'string' },
      headless: { type: 'boolean' }, help: { type: 'boolean' },
      'headless-screen': { type: 'string' },
    } });
  } catch { throw new HBrowserError('INVALID_ARGUMENTS', 'Invalid command arguments. Use hbrowser help.'); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArguments(args);
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log('HBrowser — native browser product\n  doctor [--product-dir PATH]\n  open [URL] [--profile NAME] [--headless] [--config PRIVATE_JSON]\n       [--proxy-config PRIVATE_JSON] [--timeout MILLISECONDS]\n  inspect [URL] [same launch options] — report functional API availability and close\n  environment [URL] [same launch options] — measure geometry and fonts\n  --headless-screen WIDTHxHEIGHT configures the actual headless display\n  profiles list [--profiles-root PATH]\n\nHB_PRODUCT_DIR selects the verified installation. Unnamed profiles are temporary.\nNative configuration is copied to a private file and passed as HBROWSER_CONFIG_FILE.\nHeadless open sessions remain open until SIGINT or SIGTERM.');
    return;
  }
  if (command === 'doctor') {
    if (positionals.length !== 1) throw new HBrowserError('INVALID_ARGUMENTS', 'doctor does not accept positional arguments.');
    const product = await verifyProduct(values['product-dir']);
    console.log(JSON.stringify({ product: product.manifest.product, version: product.manifest.version,
      platform: product.manifest.platform, arch: product.manifest.arch, engine: product.manifest.engine,
      verifiedFiles: product.manifest.files.length, integrityVerified: true, browserLaunchValidated: false }, null, 2));
    return;
  }
  if (command === 'profiles' && positionals[1] === 'list' && positionals.length === 2) {
    console.log(JSON.stringify(await listProfiles(values['profiles-root']), null, 2));
    return;
  }
  if (!['open', 'inspect', 'environment'].includes(command) || positionals.length > 2) throw new HBrowserError('INVALID_ARGUMENTS', 'Unknown command. Use hbrowser help.');
  const url = positionals[1] ?? 'about:blank';
  try {
    if (url !== 'about:blank') {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error();
    }
  } catch { throw new HBrowserError('INVALID_URL', 'Open requires an HTTP(S) URL without embedded credentials, or about:blank.'); }
  const proxy = values['proxy-config'] ? validateProxy(await readPrivateJson(values['proxy-config'])) : undefined;
  const geometry = values['headless-screen'];
  if (geometry !== undefined && !/^[0-9]{3,4}x[0-9]{3,4}$/.test(geometry)) throw new HBrowserError('INVALID_SCREEN', 'Use --headless-screen WIDTHxHEIGHT with --headless.');
  const headlessScreen = geometry ? { width: Number(geometry.split('x')[0]), height: Number(geometry.split('x')[1]) } : undefined;
  let browser: HBrowser | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; void browser?.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  try {
    browser = await launchHBrowser({ productDir: values['product-dir'], profilesRoot: values['profiles-root'],
      profile: values.profile, headless: values.headless, configPath: values.config, proxy,
      timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout), headlessScreen });
    // A signal received during startup still waits for the launch to settle and closes its owned browser.
    if (interrupted) return;
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    const navigation = await page.goto(url, { timeout: values.timeout === undefined ? 30_000 : Number(values.timeout), waitUntil: 'domcontentloaded' });
    if (command === 'environment') {
      console.log(JSON.stringify({ product: browser.product.manifest.version, environment: await inspectEnvironment(page), fonts: await inventoryFonts() }, null, 2));
      return;
    }
    if (command === 'inspect') {
      console.log(JSON.stringify({ product: browser.product.manifest.product, version: browser.product.manifest.version,
        engine: browser.product.manifest.engine, profile: browser.profile.temporary ? 'temporary' : 'persistent',
        navigation: { httpStatus: navigation?.status() ?? null },
        context: 'automation-isolated-world', capabilities: await inspectCapabilities(page),
        interpretation: 'Functional browser API availability.' }, null, 2));
      return;
    }
    console.log(`HBrowser ${browser.product.manifest.version} is running (${browser.profile.temporary ? 'temporary profile' : 'persistent profile'}).`);
    await browser.closed;
  } catch (error) {
    if (!interrupted) throw error instanceof HBrowserError ? error : new HBrowserError('NAVIGATION_FAILED', 'HBrowser could not open the requested page.');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop);
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof HBrowserError ? `${error.code}: ${error.message}` : 'HBrowser command failed. Check configuration and installation.');
    process.exitCode = 1;
  });
}
