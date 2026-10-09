"""Compile the real native overlay and patched pinned MaskConfig on Linux."""

from __future__ import annotations

import json
import os
from pathlib import Path
import resource
import shutil
import stat
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = Path(os.environ.get("HBROWSER_CAMOUFOX_SOURCE", ROOT / "browser/vendor/camoufox"))
REVISION = json.loads((ROOT / "browser/engine.lock.json").read_text())["upstream"]["revision"]
MAX_BYTES = 1024 * 1024

FILE_PROBE = r'''
#include "HBrowserConfigFile.hpp"
#include <cstdio>
int main(int argc, char** argv) {
  std::optional<std::string> path;
  if (argc > 1) path = argv[1];
  if (argc > 2 && std::string(argv[2]) == "nul") path = std::string("x\0y", 3);
  const int iterations = argc > 2 && std::string(argv[2]) == "repeat" ? 500 : 1;
  hbrowser::ConfigFileResult result;
  for (int i = 0; i < iterations; ++i) {
    result = hbrowser::ReadConfigFile(path);
    if (!result.error.empty()) {
      std::fprintf(stderr, "%s\n", result.error.c_str());
      return 1;
    }
  }
  if (!result.requested) {
    std::printf("not-requested\n");
  } else {
    std::fwrite(result.contents.data(), 1, result.contents.size(), stdout);
  }
}
'''

MASK_PROBE = r'''
#include "MaskConfig.hpp"
#include <cerrno>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "sandbox") {
    // Deny filesystem opens after startup; config getters must use their cache.
    struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_open, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
      static_cast<unsigned short>(sizeof(filter) / sizeof(filter[0])), filter};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) return 2;
    errno = 0;
    const int descriptor = open(std::getenv("HBROWSER_CONFIG_FILE"), O_RDONLY);
    if (descriptor != -1 || errno != EACCES) return 3;
  }
  if (argc > 1 && std::string(argv[1]) == "cached") {
    setenv("HBROWSER_CONFIG_FILE", "/nonexistent/hbrowser-config-after-startup", 1);
  }
  std::printf("%s\n", MaskConfig::GetJson().dump().c_str());
}
'''

DEBUG_SHIM = r'''
#pragma once
#include <cstdarg>
#include <cstdio>
inline void printf_stderr(const char* format, ...) {
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
}
'''


class NativeConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("g++"):
            raise RuntimeError("Native checks require g++ (C++17).")
        if not (UPSTREAM / ".git").exists():
            raise RuntimeError("Fetch the pinned engine source before native checks.")
        cls.build_tmp = tempfile.TemporaryDirectory(prefix="hbrowser-native-tests-")
        cls.addClassCleanup(cls.build_tmp.cleanup)
        cls.build = Path(cls.build_tmp.name)
        subprocess.run(["git", "init", "-q", str(cls.build)], check=True)
        includes = cls.build / "additions/camoucfg"
        includes.mkdir(parents=True)
        for name in ["MaskConfig.hpp", "json.hpp", "moz.build"]:
            contents = subprocess.check_output(
                ["git", "-C", str(UPSTREAM), "show", f"{REVISION}:additions/camoucfg/{name}"]
            )
            (includes / name).write_bytes(contents)
        patch = ROOT / "browser/patches/0001-private-config-file.patch"
        subprocess.run(["git", "-C", str(cls.build), "apply", "--check", str(patch)], check=True)
        subprocess.run(["git", "-C", str(cls.build), "apply", str(patch)], check=True)
        for source in (ROOT / "browser/native").glob("*"):
            if source.is_file():
                shutil.copyfile(source, includes / source.name)
        shim = cls.build / "mozilla/glue/Debug.h"
        shim.parent.mkdir(parents=True)
        shim.write_text(DEBUG_SHIM)
        cls.file_probe = cls.build / "file-probe"
        cls.mask_probe = cls.build / "mask-probe"
        for name, contents, output, extra in [
            ("file-probe.cpp", FILE_PROBE, cls.file_probe, []),
            ("mask-probe.cpp", MASK_PROBE, cls.mask_probe, [str(includes / "HBrowserStartup.cpp")]),
        ]:
            probe = cls.build / name
            probe.write_text(contents)
            subprocess.run(
                ["g++", "-std=c++17", "-fno-exceptions", "-Wall", "-Wextra", "-Werror",
                 "-pthread", "-I", str(includes), "-I", str(cls.build), str(probe),
                 *extra, "-o", str(output)], check=True, capture_output=True, text=True,
            )

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hbrowser-config-test-")
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.path = self.directory / "config.json"
        self.write_config('{"debug":false,"test-label":"équipe"}')
        self.environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith("CAMOU_CONFIG") and key != "HBROWSER_CONFIG_FILE"
        }

    def write_config(self, content, mode=0o600):
        self.path.write_bytes(content.encode() if isinstance(content, str) else content)
        self.path.chmod(mode)

    def file(self, *arguments, **options):
        return subprocess.run(
            [str(self.file_probe), *map(str, arguments)], capture_output=True,
            timeout=5, text=True, env=self.environment, **options,
        )

    def mask(self, *, file=True, updates=None, args=()):
        env = self.environment.copy()
        if file:
            env["HBROWSER_CONFIG_FILE"] = str(self.path)
        env.update(updates or {})
        return subprocess.run(
            [str(self.mask_probe), *args], env=env, capture_output=True, text=True, timeout=5,
        )

    def assert_rejected(self, result, expected):
        self.assertEqual(result.returncode, 1, result)
        self.assertIn(expected, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_absent_file_source_preserves_legacy_environment(self):
        result = self.mask(file=False, updates={"CAMOU_CONFIG": '{"debug":true}'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"debug": True})
        self.assertEqual(self.file().stdout, "not-requested\n")

    def test_absent_file_source_preserves_chunked_environment_precedence(self):
        result = self.mask(file=False, updates={
            "CAMOU_CONFIG": '{"debug":false}',
            "CAMOU_CONFIG_1": '{"debug":', "CAMOU_CONFIG_2": "true}",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"debug": True})

    def test_file_takes_precedence_and_preserves_unicode(self):
        result = self.mask(updates={"CAMOU_CONFIG": '{"debug":true}', "CAMOU_CONFIG_1": "invalid"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"debug": False, "test-label": "équipe"})

    def test_read_only_owner_file(self):
        self.path.chmod(0o400)
        result = self.mask()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_integer_precision_and_unicode_surrogate_pair(self):
        self.write_config(r'{"integer":9007199254740993,"label":"\ud83d\ude80","float":1e300}')
        result = self.mask()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"integer": 9007199254740993, "label": "🚀", "float": 1e300})

    def test_invalid_paths_never_fall_back_to_environment(self):
        for path in ["", str(self.directory / "missing")]:
            with self.subTest(path=path):
                self.assert_rejected(self.mask(updates={
                    "HBROWSER_CONFIG_FILE": path, "CAMOU_CONFIG": '{"debug":true}',
                }), "HBROWSER_CONFIG_FILE")

    def test_nul_path_is_rejected(self):
        self.assert_rejected(self.file(self.path, "nul"), "NUL")

    def test_invalid_json_and_non_object_roots_fail_before_main(self):
        for contents in ["", "{broken", "[]", "null", "false", '"text"', "42", b'{"x":"\xff"}', '{"x":1e9999}',
                         r'{"value":"\ud800"}', r'{"\udfff":1}', '{"v":1e400,"v":0}',
                         r'{"v":"\ud800","v":"ok"}']:
            with self.subTest(contents=contents):
                self.write_config(contents)
                self.assert_rejected(self.mask(updates={"CAMOU_CONFIG": "{}"}), "valid JSON object")

    def test_file_at_exact_limit_is_accepted(self):
        self.write_config('{"value":"' + "a" * (MAX_BYTES - len('{"value":""}')) + '"}')
        result = self.mask()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["value"]), MAX_BYTES - 12)

    def test_oversized_file_is_rejected(self):
        self.write_config(" " * (MAX_BYTES + 1))
        self.assert_rejected(self.mask(), "1 MiB")

    def test_public_and_executable_permissions_are_rejected(self):
        for mode in [0o644, 0o640, 0o606, 0o700, 0o4600]:
            with self.subTest(mode=oct(mode)):
                self.path.chmod(mode)
                self.assert_rejected(self.mask(), "private permissions")

    def test_unreadable_file_is_rejected(self):
        self.path.chmod(0)
        self.assert_rejected(self.mask(), "HBROWSER_CONFIG_FILE")

    def test_file_owned_by_another_user_is_rejected(self):
        options = {}
        effective_uid = os.geteuid()
        if effective_uid == 0:
            effective_uid = 65534
            options["preexec_fn"] = lambda: os.setuid(65534)
            # The probe lives in a private temporary directory by default.
            self.build.chmod(0o755)
        candidates = [Path("/etc/passwd"), Path("/usr/bin/env"), Path("/proc/sys/kernel/hostname")]
        path = next((candidate.resolve() for candidate in candidates
                     if candidate.is_file() and candidate.stat().st_uid != effective_uid
                     and candidate.stat().st_mode & stat.S_IROTH), None)
        self.assertIsNotNone(path, "A readable system file owned by another user is required")
        result = self.file(path, **options)
        self.assert_rejected(result, "belong to the current user")

    def test_symlink_is_rejected(self):
        link = self.directory / "link.json"
        link.symlink_to(self.path)
        self.assert_rejected(self.file(link), "cannot open")

    def test_directory_is_rejected(self):
        self.assert_rejected(self.file(self.directory), "regular file")

    def test_fifo_is_rejected_without_waiting_for_writer(self):
        fifo = self.directory / "fifo"
        os.mkfifo(fifo, 0o600)
        self.assert_rejected(self.file(fifo), "regular file")

    def test_device_is_rejected(self):
        self.assert_rejected(self.file("/dev/null"), "regular file")

    def test_file_descriptors_are_closed(self):
        def limited_descriptors():
            resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        result = self.file(self.path, "repeat", preexec_fn=limited_descriptors)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_constructor_loads_file_before_main(self):
        result = self.mask(args=("cached",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["test-label"], "équipe")

    def test_cached_config_survives_filesystem_syscall_denial(self):
        result = self.mask(args=("sandbox",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["test-label"], "équipe")


if __name__ == "__main__":
    unittest.main()
