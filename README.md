# HBrowser

A native Firefox browser distribution based on [Camoufox](https://github.com/daijro/camoufox), with a TypeScript SDK and command-line launcher. The current target is **Linux x64**, HBrowser **0.2.0-dev.2**, Firefox **157.0.1**.

HBrowser adds private native configuration loaded before the Linux content sandbox, verified installations, isolated temporary or persistent profiles, process-aware cleanup, and a fix for dynamic `prefers-contrast` updates. The SDK controls the compiled browser through Playwright's Firefox transport.

## Get started

Install Node.js **24.21.0** and Python **3.12+**, then:

```sh
git clone https://github.com/kaminskimala/hbrowser-native.git
cd hbrowser-native
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
npm test
```

`npm run build` compiles the TypeScript SDK. To produce the browser executable, follow the [native build instructions](browser/README.md). The SDK requires a separately built and verified HBrowser installation:

```sh
export HB_PRODUCT_DIR=/path/to/installed/hbrowser-0.2.0-dev.2
npm run browser -- doctor
npm run browser -- open about:blank --profile main
npm run browser -- profiles list
```

The optional `scripts/bootstrap-node.sh` installs the pinned Node runtime under `.tools/` on Linux x64. Use `scripts/npmw` and `scripts/hbrowser-native` with that runtime.

## TypeScript SDK

After building the SDK, a script in this checkout can import it directly:

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

An unnamed profile is temporary and removed after confirmed browser exit. A named profile persists and holds an exclusive lock. Profiles default to `~/.local/share/hbrowser/profiles`; `profilesRoot` selects another location. If process exit cannot be confirmed, the SDK retains the lock and private configuration for inspection.

Pass `configPath` to use a native Camoufox JSON configuration file, or `--config /path/to/config.json` on the CLI. The file must belong to the current user, have permissions `0400` or `0600`, and contain a JSON object of at most 1 MiB. The SDK creates a private session copy. An empty object uses upstream defaults.

A proxy can be supplied as `proxy: { server, username, password, bypass }` or `--proxy-config /path/to/private-proxy.json`. Credentials belong in the private file, not the URL or command-line arguments.

`inspect` reports functional browser API availability. `environment` reports observed geometry and fonts. These measurements do not establish acceptance by a site's bot protection.

## Source and tests

| Directory | Contents |
| --- | --- |
| `browser/` | Pinned engine sources, native additions, patches, build and installation tooling |
| `src/browser/` | Browser SDK, CLI, configuration, profiles and process lifecycle |
| `tests/` | SDK tests and local browser compatibility fixtures |
| `scripts/` | Optional Node setup and launch helpers |

The upstream Firefox and Camoufox trees are fetched using the revisions and SHA-256 checksums in [engine.lock.json](browser/engine.lock.json). This repository contains the HBrowser changes and build recipe; it does not duplicate the multi-gigabyte Firefox tree.

```sh
npm test                 # SDK unit tests; no browser installation needed
npm run test:native      # Build/configuration tests; pinned Camoufox checkout needed
HB_PRODUCT_DIR=/path/to/product HB_REQUIRE_NATIVE=1 npm run test:product:e2e
```

See the [build guide](browser/README.md) for prerequisites and native test setup, and the [patch descriptions](browser/patches/README.md) for the engine changes. The browser tests use local HTTP fixtures. The release targets Linux x64 and uses system fonts; other platforms have not been qualified. Source inputs are pinned, but the full toolchain is not hermetic or guaranteed to produce identical binary hashes.

## License

HBrowser source is available under the [Mozilla Public License 2.0](LICENSE). Camoufox, Firefox and other upstream components retain their notices and licenses; see [NOTICE](NOTICE). HBrowser is an independent derivative project.
