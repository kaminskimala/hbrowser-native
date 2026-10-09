# HBrowser native changes

These patches target Camoufox commit
`e6a398849b28721beff7423e8a47e41c6a3b2312`. Apply them at the Camoufox repository
root, before its `make dir` step copies additions into Firefox. Copy
`../native/HBrowserConfigFile.hpp` and `../native/HBrowserStartup.cpp` into
`additions/camoucfg/` first.

`0001-private-config-file.patch` adds `HBROWSER_CONFIG_FILE` to the existing
native `MaskConfig` reader. The file is a UTF-8 JSON object with the same keys
as Camoufox configuration. It takes precedence over `CAMOU_CONFIG` and its
numbered chunks. Without `HBROWSER_CONFIG_FILE`, upstream behavior is unchanged.
An explicitly configured empty path, failed read, invalid JSON, or non-object
root ends the process with a diagnostic and a failure exit code. Diagnostics
do not print configuration contents.

The Linux file reader requires an ordinary file owned by the effective user,
permissions `0400` or `0600`, and at most 1,048,576 bytes. It refuses a symlink
at the final path component and rejects directories, devices, and FIFOs. The
size limit applies both before and during the read. Keep the private file
present and unchanged throughout the browser session: subprocesses may load
their configuration when they start.

`HBrowserStartup.cpp` preloads and caches the configuration at libxul load time
on Linux, before the content sandbox. This ordering follows the pinned Firefox
157.0.1 sources (the same sequence was originally checked on 156.0.1):

- [`MozillaRuntimeMain.cpp`](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_157_0_1_RELEASE/ipc/app/MozillaRuntimeMain.cpp)
  calls `GetBootstrap()` before `XRE_InitChildProcess()`, including the forkserver path.
- [`nsXPCOMGlue.cpp`](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_157_0_1_RELEASE/xpcom/glue/standalone/nsXPCOMGlue.cpp)
  loads libxul through `XPCOMGlueLoad()` and `dlopen()` in `GetBootstrap()`.
- [`nsEmbedFunctions.cpp`](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_157_0_1_RELEASE/toolkit/xre/nsEmbedFunctions.cpp)
  performs `SandboxEarlyInit()` within `XRE_InitChildProcess()`.

Native checks compile the actual patched upstream `MaskConfig.hpp` and its
bundled JSON parser, with exceptions disabled. They exercise file precedence,
legacy environment inputs, malformed JSON, size boundaries, permissions,
special files, descriptor cleanup, constructor timing, and cached access after
a Linux seccomp filter denies file opens. These checks do not replace a full
Firefox build and packaged-browser smoke test.

```sh
python3 -m unittest discover -s browser/tests -p test_native.py -v
```

`0002-display-brand.patch` changes display strings to HBrowser. The internal
Camoufox application name, binary basename, and branding directory stay aligned
with the upstream packaging tools. Upstream artwork remains unchanged.

`0003-build-failures.patch` makes a failed upstream patch command fatal even
when it leaves no `.rej` file. It also removes the unconditional Rust ARM64
target download from the patching step: HBrowser bootstraps its selected Linux
x64 target through Mozilla's build tooling instead.

`0004-native-build-graph.patch` adds a Firefox patch registering `/camoucfg`
under `COMPILE_ENVIRONMENT` in `toolkit/toolkit.mozbuild`. This makes its
`FINAL_LIBRARY = "xul"` source part of the actual build. Before compilation,
`build.py` runs `mach configure` and verifies the generated backend traversed
the directory, compiles `HBrowserStartup.cpp`, and passes its object to libxul's
linker response file. After compilation and before packaging it also requires
an ELF64 x86-64 relocatable object file.
The inline configuration reader's presence in libxul alone cannot prove that
the startup constructor was compiled.

`0005-firefox-157.0.1.patch` advances the Firefox source version in Camoufox's
`upstream.sh`, aligned with HBrowser's source archive and official SHA-256 lock.
The Camoufox commit remains unchanged; this is HBrowser's maintenance update,
not a claim that upstream released this engine combination.

`0006-refresh-policy-banner.patch` adapts the context of the inherited
`remove-organization-policy-banner.patch` to Firefox 157. It still removes
only `maybeDisplayPoliciesNotice()` and preserves the new
`maybeDisplayTLSKeyLoggingNotice()` and the unload handler. The first isolated
preparation rejected the old context; a fresh preparation applied all 61 Firefox
patches successfully.

`0007-prefers-contrast-invalidation.patch` adds a Firefox patch correcting
`BrowsingContext::DidSet(PrefersContrastOverride)`. Changing this override must
invalidate CSS media rules and notify existing MediaQueryList listeners. The
previous generic recomputation updated new reads of the field but left those
existing consumers stale. The setter now follows the adjacent reduced-motion
setter: walk pres contexts and call `MediaFeatureValuesChanged` with
`PreferenceChange` and `JustThisDocument`, retaining the existing guards.
A permanent regression test covers existing page and iframe CSS rules and
MediaQueryList listeners in `test:product:e2e`.

The new native files and modifications to Camoufox/Mozilla source are MPL-2.0.
Preserve upstream license notices and ship corresponding source when
distributing binaries. Camoufox's bundled `json.hpp` remains unmodified and
retains Niels Lohmann's MIT notice; the native tests read it from the pinned
checkout instead of introducing a second copy.
