# HBrowser

A native Firefox browser based on [Camoufox](https://github.com/daijro/camoufox), with a TypeScript SDK and CLI. **Linux x64 · HBrowser 0.2.0-dev.2 · Firefox 157.0.1.**

HBrowser adds private native configuration, verified installations, isolated profiles, process-aware cleanup and a fix for dynamic `prefers-contrast` updates. [engine.lock.json](browser/engine.lock.json) pins the upstream sources and checksums; [browser/patches](browser/patches) contains the engine changes.

## Setup

Install Node.js **24.21.0** and Python **3.12+**:

```sh
git clone https://github.com/kaminskimala/hbrowser-native.git
cd hbrowser-native
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
```

`npm run build` compiles the SDK. Build and install the native browser separately.

## Build the browser

Use a Linux x64 host with Git, bash, make, patch, tar, a C++17 compiler and the [Firefox development dependencies](https://firefox-source-docs.mozilla.org/setup/linux_build.html). Allow **40 GiB free before preparation** and **30 GiB before bootstrap/build**, plus cache space. Run from a host terminal with an empty or HBrowser-owned workspace.

```sh
python3 browser/build.py --workspace /path/to/build doctor
python3 browser/build.py --workspace /path/to/build all --jobs 2 --out browser/releases
```

The build fetches and verifies Camoufox and Firefox, applies the patches and packages the executable. Output: `browser/releases/hbrowser-0.2.0-dev.2-linux-x64.tar.xz` and its `.sha256` file. It uses en-US and system fonts. Source inputs are pinned; the full toolchain is not hermetic.

## Install and run

Use the SHA-256 from your build output or another trusted source. Install each version into a new directory:

```sh
python3 browser/build.py install browser/releases/hbrowser-0.2.0-dev.2-linux-x64.tar.xz \
  --sha256 YOUR_ARCHIVE_SHA256 \
  --destination /path/to/installed/hbrowser-0.2.0-dev.2

export HB_PRODUCT_DIR=/path/to/installed/hbrowser-0.2.0-dev.2
npm run browser -- doctor
npm run browser -- open about:blank --profile main
npm run browser -- open about:blank --headless --headless-screen 1920x1080
npm run browser -- profiles list
```

The launcher verifies the installation before execution. Headless sessions stay open until SIGINT or SIGTERM. Run `npm run browser -- help` for CLI options.

## TypeScript SDK

From a script in this checkout:

```js
import { launchHBrowser } from './dist/src/browser/index.js';

const browser = await launchHBrowser({
  productDir: process.env.HB_PRODUCT_DIR,
  headless: true,
  headlessScreen: { width: 1920, height: 1080 },
});
try {
  const page = await browser.context.newPage();
  await page.goto('about:blank');
  console.log(await page.title());
} finally {
  await browser.close();
}
```

Unnamed profiles are removed after confirmed browser exit. Named profiles persist under `~/.local/share/hbrowser/profiles` with an exclusive lock; `profilesRoot` overrides the location. Unconfirmed exit preserves the lock and private configuration.

Use `configPath` or CLI `--config` for a Camoufox JSON object of at most 1 MiB, owned by the current user with permissions `0400` or `0600`. The SDK creates a private session copy; `{}` uses upstream defaults. Supply proxies through SDK `proxy: { server, username, password, bypass }` or a private `--proxy-config` JSON file. Keep credentials out of URLs and command arguments.

## Tests

`npm test` runs SDK tests without an installed browser. Native source checks need the pinned Camoufox checkout:

```sh
HB_REVISION=$(python3 -c 'import json; print(json.load(open("browser/engine.lock.json"))["upstream"]["revision"])')
git init browser/vendor/camoufox
git -C browser/vendor/camoufox fetch --depth 1 https://github.com/daijro/camoufox.git "$HB_REVISION"
git -C browser/vendor/camoufox checkout --detach FETCH_HEAD
npm run test:native
```

Test the installed browser against local fixtures:

```sh
HB_PRODUCT_DIR=/path/to/installed/hbrowser-0.2.0-dev.2 \
  HB_REQUIRE_NATIVE=1 npm run test:product:e2e
```

CI runs SDK/native source checks. Full compilation is a manual workflow on a configured `self-hosted`, `linux`, `x64`, `hbrowser-build` runner.

## License

HBrowser source is available under the [Mozilla Public License 2.0](LICENSE). Camoufox, Firefox and other upstream components retain their notices and licenses; see [NOTICE](NOTICE). HBrowser is an independent derivative project.
