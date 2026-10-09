# Build HBrowser

The build starts from Camoufox commit `e6a398849b28721beff7423e8a47e41c6a3b2312` and applies the HBrowser patches, including the update to Firefox 157.0.1. Archive URLs and SHA-256 checksums are recorded in [engine.lock.json](engine.lock.json).

## Requirements

Use a Linux x64 host with Python 3.12+, Git, bash, make, patch, tar, a C++17 compiler and the development libraries needed by Firefox. The [Mozilla Linux build guide](https://firefox-source-docs.mozilla.org/setup/linux_build.html) describes the system dependencies. Run the build from a host terminal.

Allow at least **40 GiB free before preparation** and **30 GiB free before bootstrap/build**, with extra space for caches and repeated builds. The bootstrap downloads Mozilla's user tools; HBrowser does not install system packages with `sudo`.

```sh
python3 browser/build.py --workspace /path/with/free-space doctor
python3 browser/build.py --workspace /path/with/free-space all --jobs 2 --out browser/releases
```

`doctor` reports prerequisites and returns status 2 when they are missing. The workspace must be empty or already owned by this build tool. Unknown directories are not cleaned, concurrent builds are rejected, and resumed builds check the HBrowser inputs.

## Individual build steps

```sh
python3 browser/build.py --workspace /path/with/free-space fetch
python3 browser/build.py --workspace /path/with/free-space prepare
python3 browser/build.py --workspace /path/with/free-space bootstrap
python3 browser/build.py --workspace /path/with/free-space build --jobs 2
python3 browser/build.py --workspace /path/with/free-space package --out browser/releases
```

`fetch` verifies the Camoufox archive and applies the HBrowser additions and patches. `prepare` verifies and extracts the Firefox source archive, then applies the upstream engine patches. Use a new workspace after an interrupted preparation; the interrupted tree is retained for inspection.

The output is `hbrowser-0.2.0-dev.2-linux-x64.tar.xz` and its `.sha256` file. The package includes the executable, `libxul.so`, resources, notices, HBrowser patches, native additions and a manifest covering every packaged file. The internal executable name remains `camoufox-bin`; the displayed product name is HBrowser. This build uses en-US and system fonts.

## Install and launch

Obtain the archive's SHA-256 from your build output or another trusted source:

```sh
python3 browser/build.py install browser/releases/hbrowser-0.2.0-dev.2-linux-x64.tar.xz \
  --sha256 YOUR_ARCHIVE_SHA256 \
  --destination /path/to/installed/hbrowser-0.2.0-dev.2

export HB_PRODUCT_DIR=/path/to/installed/hbrowser-0.2.0-dev.2
npm run browser -- doctor
npm run browser -- open about:blank --profile main
npm run browser -- open about:blank --headless --headless-screen 1920x1080
```

Install each version into a new directory. The launcher checks package hashes before executing the browser and rejects symlinks in the installation. The manifest is an integrity record, not a publisher signature. A headless `open` session stays alive until SIGINT or SIGTERM.

## Validate the sources

The native tests compile the private configuration reader and the actual pinned upstream `MaskConfig.hpp`. Prepare a Git checkout for these tests:

```sh
HB_REVISION=$(python3 -c 'import json; print(json.load(open("browser/engine.lock.json"))["upstream"]["revision"])')
git init browser/vendor/camoufox
git -C browser/vendor/camoufox fetch --depth 1 https://github.com/daijro/camoufox.git "$HB_REVISION"
git -C browser/vendor/camoufox checkout --detach FETCH_HEAD
npm test
npm run test:native
```

Alternatively, set `HBROWSER_CAMOUFOX_SOURCE` to a Git checkout containing the pinned commit. The tests also cover archive extraction, installation, manifests and build input integrity. They do not compile the whole Firefox engine.

After installing a compiled package:

```sh
HB_PRODUCT_DIR=/path/to/installed/hbrowser-0.2.0-dev.2 \
  HB_REQUIRE_NATIVE=1 npm run test:product:e2e
```

This verifies native configuration, persistent and temporary profiles, contrast invalidation, local HTTP interactions, workers, storage and browser APIs. Set `HB_NATIVE_HEADED=1` to run the compatibility scenarios with a window; the two product regression scenarios remain headless. `HB_EXPECTED_MANIFEST_SHA256` optionally pins the manifest in the compatibility harness. Tests requiring an installation skip when none is selected unless `HB_REQUIRE_NATIVE=1` is set.

The GitHub workflow runs SDK and native source checks on pushes and pull requests. Full compilation is a manual workflow on a configured `self-hosted`, `linux`, `x64`, `hbrowser-build` runner with sufficient disk space.
