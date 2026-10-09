"""Exercise build input, archive and installation boundaries without a browser build."""
from __future__ import annotations

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('hbrowser_build', Path(__file__).parents[1] / 'build.py')
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hbrowser-build-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, members):
        path = self.root / 'input.tar'
        with tarfile.open(path, 'w') as stream:
            for name, kind, value in members:
                entry = tarfile.TarInfo(name)
                entry.mode = 0o755 if kind == 'directory' else 0o644
                if kind == 'file':
                    entry.size = len(value)
                    stream.addfile(entry, io.BytesIO(value))
                else:
                    entry.type = {'directory': tarfile.DIRTYPE, 'symlink': tarfile.SYMTYPE,
                                  'hardlink': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE}[kind]
                    if kind in ('symlink', 'hardlink'):
                        entry.linkname = value
                    stream.addfile(entry)
        return path

    def product(self):
        root = self.root / 'product'
        root.mkdir()
        for name, value in {'camoufox-bin': b'browser fixture', 'libxul.so': b'engine fixture',
                            'provenance/patches/native.patch': b'native patch fixture'}.items():
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
        (root / 'camoufox-bin').chmod(0o755)
        files = [{'path': p.relative_to(root).as_posix(), 'sha256': build.digest(p)}
                 for p in sorted(root.rglob('*')) if p.is_file()]
        manifest = {'schemaVersion': 1, 'product': 'HBrowser', 'version': '0.2.0-dev.1',
                    'platform': 'linux', 'arch': 'x64', 'executable': 'camoufox-bin',
                    'engine': {'name': 'camoufox', 'revision': 'a' * 40, 'firefoxVersion': '156.0.1'},
                    'files': files, 'patches': [copy.deepcopy(files[-1])]}
        build.write_json(root / 'hbrowser-build.json', manifest)
        return root, manifest

    def packed_product(self):
        root, manifest = self.product()
        archive = self.root / 'product.tar'
        with tarfile.open(archive, 'w') as stream:
            stream.add(root, arcname='hbrowser')
        return archive, manifest

    def native_graph(self, source):
        obj = source / 'obj-hbrowser'
        native = obj / 'camoucfg'
        linker = obj / 'toolkit/library/build'
        native.mkdir(parents=True, exist_ok=True)
        linker.mkdir(parents=True, exist_ok=True)
        (obj / 'backend.RecursiveMakeBackend.in').write_text(str(source / 'camoucfg/moz.build') + '\n')
        (native / 'backend.mk').write_text('CPPSRCS += $(srcdir)/HBrowserStartup.cpp\n')
        response = linker / 'libxul_so.list'
        response.write_text('../../../camoucfg/HBrowserStartup.o\n')
        (linker / 'backend.mk').write_text(f'libxul.so_OBJS := -Wl,@{response}\n')
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[16:20] = b'\x01\x00\x3e\x00'
        (native / 'HBrowserStartup.o').write_bytes(header + b'SYNTHETIC OBJECT TEST ONLY')
        return obj

    def test_archive_accepts_confined_file_and_links(self):
        archive = self.archive([('src', 'directory', ''), ('src/real', 'file', b'data'),
                                ('src/symbolic', 'symlink', 'real'),
                                ('src/hard', 'hardlink', 'src/real')])
        root = build.extract(archive, self.root / 'out', 100)
        self.assertEqual((root / 'symbolic').read_bytes(), b'data')
        self.assertEqual((root / 'hard').read_bytes(), b'data')

    def test_archive_ignores_root_directory_markers_without_applying_metadata(self):
        for index, marker in enumerate(('.', './')):
            with self.subTest(marker=marker):
                destination = self.root / f'out-{index}'
                destination.mkdir(mode=0o700)
                archive = self.archive([(marker, 'directory', ''),
                                        ('src', 'directory', ''),
                                        ('src/configure.py', 'file', b'firefox source')])
                root = build.extract(archive, destination, 100)
                self.assertEqual(root, destination / 'src')
                self.assertEqual((root / 'configure.py').read_bytes(), b'firefox source')
                # The marker's 0755 mode and zero mtime must not reach out/.
                self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
                self.assertNotEqual(destination.stat().st_mtime, 0)

    def test_archive_root_marker_does_not_allow_unsafe_or_missing_roots(self):
        scenarios = [
            [('.', 'file', b'x')],
            [('.', 'symlink', 'src'), ('src/file', 'file', b'x')],
            [('.', 'hardlink', 'src/file'), ('src/file', 'file', b'x')],
            [('', 'directory', ''), ('src/file', 'file', b'x')],
            [('./.', 'directory', ''), ('src/file', 'file', b'x')],
            [('.', 'directory', '')],
            [],
            [('.', 'directory', ''), ('../escape', 'file', b'x')],
            [('.', 'directory', ''), ('first/a', 'file', b'x'), ('second/b', 'file', b'x')],
        ]
        for index, members in enumerate(scenarios):
            with self.subTest(members=members), self.assertRaises((build.BuildError, tarfile.TarError)):
                build.extract(self.archive(members), self.root / f'out-{index}', 100)

    def test_archive_rejects_paths_duplicates_special_files_and_escaping_links(self):
        scenarios = [
            [('src/../escape', 'file', b'x')],
            [('/absolute', 'file', b'x')],
            [('src/item', 'file', b'a'), ('src/item', 'file', b'b')],
            [('src', 'directory', ''), ('src/', 'directory', '')],
            [('src/fifo', 'fifo', '')],
            [('src/link', 'symlink', '../outside')],
            [('src/link', 'symlink', '/outside')],
            [('src/link', 'hardlink', 'elsewhere/file')],
            [('src/real', 'directory', ''), ('src/link', 'symlink', 'real'),
             ('src/link/child', 'file', b'x')],
            [('first/a', 'file', b'x'), ('second/b', 'file', b'y')],
        ]
        for members in scenarios:
            with self.subTest(members=members):
                with self.assertRaises((build.BuildError, tarfile.TarError)):
                    build.extract(self.archive(members), self.root / 'out', 100)
                self.assertFalse((self.root / 'escape').exists())

    def test_archive_size_limit_is_checked_before_extracting(self):
        archive = self.archive([('src/data', 'file', b'12345')])
        with self.assertRaises(build.BuildError):
            build.extract(archive, self.root / 'out', 4)
        self.assertFalse((self.root / 'out').exists())

    def test_valid_product_passes_and_installs_with_permissions(self):
        archive, manifest = self.packed_product()
        destination = self.root / 'installed'
        build.install(archive, build.digest(archive), destination)
        self.assertEqual(build.verify_product(destination), manifest)
        self.assertTrue(os.access(destination / 'camoufox-bin', os.X_OK))

    def test_product_tampering_and_unlisted_nested_manifest_are_rejected(self):
        root, manifest = self.product()
        (root / 'libxul.so').write_bytes(b'changed')
        with self.assertRaises(build.BuildError):
            build.verify_product(root)
        (root / 'libxul.so').write_bytes(b'engine fixture')
        (root / 'provenance/hbrowser-build.json').write_text('{}')
        with self.assertRaises(build.BuildError):
            build.verify_product(root)

    def test_manifest_matches_sdk_schema_and_patch_coverage(self):
        root, original = self.product()
        mutations = [
            lambda m: m.update(version='latest'),
            lambda m: m.update(engine={'name': 'firefox', 'revision': 'a' * 40, 'firefoxVersion': '156.0.1'}),
            lambda m: m['engine'].update(revision='short'),
            lambda m: m['engine'].update(firefoxVersion='unknown'),
            lambda m: m.update(files={}),
            lambda m: m['files'][0].update(path=42),
            lambda m: m['files'][0].update(path=''),
            lambda m: m['files'][0].update(path='dir\\file'),
            lambda m: m['files'][0].update(path='dir:file'),
            lambda m: m['files'][0].update(sha256='g' * 64),
            lambda m: m['files'].append(copy.deepcopy(m['files'][0])),
            lambda m: m['patches'].append(copy.deepcopy(m['patches'][0])),
            lambda m: m.update(patches=[copy.deepcopy(m['files'][0])]),
        ]
        for mutate in mutations:
            manifest = copy.deepcopy(original)
            mutate(manifest)
            build.write_json(root / 'hbrowser-build.json', manifest)
            with self.subTest(manifest=manifest), self.assertRaises(build.BuildError):
                build.verify_product(root)

    def test_manifest_and_product_root_cannot_be_symlinks(self):
        root, _ = self.product()
        alias = self.root / 'alias'
        alias.symlink_to(root, target_is_directory=True)
        with self.assertRaises(build.BuildError):
            build.verify_product(alias)
        manifest = root / 'hbrowser-build.json'
        manifest.rename(self.root / 'manifest.json')
        manifest.symlink_to(self.root / 'manifest.json')
        with self.assertRaises(build.BuildError):
            build.verify_product(root)

    def test_install_failure_never_publishes_or_overwrites(self):
        archive, _ = self.packed_product()
        destination = self.root / 'installed'
        before = set(self.root.iterdir())
        with self.assertRaises(build.BuildError):
            build.install(archive, '0' * 64, destination)
        self.assertEqual(set(self.root.iterdir()), before)
        destination.mkdir()
        sentinel = destination / 'mine'
        sentinel.write_text('preserved')
        with self.assertRaises(build.BuildError):
            build.install(archive, build.digest(archive), destination)
        self.assertEqual(sentinel.read_text(), 'preserved')

    def test_install_verification_failure_cleans_temporary_tree(self):
        archive, _ = self.packed_product()
        destination = self.root / 'installed'
        before = set(self.root.iterdir())
        with patch.object(build, 'verify_product', side_effect=build.BuildError('tampered')):
            with self.assertRaises(build.BuildError):
                build.install(archive, build.digest(archive), destination)
        self.assertEqual(set(self.root.iterdir()), before)

    def test_install_never_replaces_concurrently_created_empty_directory(self):
        archive, _ = self.packed_product()
        destination = self.root / 'installed'
        verify = build.verify_product
        def racing_verify(root):
            result = verify(root)
            self.assertFalse(destination.exists())
            destination.mkdir()
            return result
        with patch.object(build, 'verify_product', side_effect=racing_verify):
            with self.assertRaises((build.BuildError, FileExistsError)):
                build.install(archive, build.digest(archive), destination)
        self.assertEqual(list(destination.iterdir()), [])

    def test_workspace_lock_excludes_other_builder_and_releases(self):
        workspace = self.root / 'work'
        with build.own_workspace(workspace):
            with self.assertRaises(build.BuildError):
                with build.own_workspace(workspace):
                    self.fail('Second builder acquired the lock')
        with build.own_workspace(workspace):
            self.assertEqual(build.read_json(workspace / '.hbrowser-workspace.json')['product'], 'HBrowser')

    def test_workspace_does_not_claim_foreign_directory_or_symlink_marker(self):
        workspace = self.root / 'work'
        workspace.mkdir()
        (workspace / 'foreign.txt').write_text('mine')
        with self.assertRaises(build.BuildError):
            with build.own_workspace(workspace):
                pass
        self.assertEqual(set(p.name for p in workspace.iterdir()), {'foreign.txt'})
        (workspace / 'foreign.txt').unlink()
        external = self.root / 'marker.json'
        external.write_text('{"schemaVersion":1,"product":"HBrowser"}')
        (workspace / '.hbrowser-workspace.json').symlink_to(external)
        with self.assertRaises(build.BuildError):
            with build.own_workspace(workspace):
                pass

    def test_fetch_and_prepare_reject_small_disk_without_download(self):
        for operation in ('fetch', 'prepare'):
            workspace = self.root / operation
            workspace.mkdir()
            usage = shutil._ntuple_diskusage(100 * build.GIB, 100 * build.GIB, 0)
            with self.subTest(operation=operation), patch.object(build.shutil, 'disk_usage', return_value=usage), \
                    patch.object(build, 'download') as download, patch.object(build, 'run') as run:
                with self.assertRaises(build.BuildError):
                    getattr(build.Builder(workspace), operation)()
                download.assert_not_called()
                run.assert_not_called()
                self.assertEqual(list(workspace.iterdir()), [])

    def test_changed_native_sources_or_patches_invalidate_saved_stage(self):
        root = self.root / 'build-inputs'
        root.mkdir()
        for name in ('engine.lock.json', 'build.py'):
            shutil.copyfile(build.ROOT / name, root / name)
        for name in ('native', 'patches'):
            (root / name).mkdir()
        source = root / 'native/HBrowserConfigFile.hpp'
        source.write_text('first')
        workspace = self.root / 'work'
        workspace.mkdir()
        with patch.object(build, 'ROOT', root):
            builder = build.Builder(workspace)
            builder.save('fetched')
            self.assertEqual(builder.state('fetched')['stage'], 'fetched')
            source.write_text('changed')
            with self.assertRaisesRegex(build.BuildError, 'inputs changed'):
                builder.state('fetched')
            with self.assertRaisesRegex(build.BuildError, 'inputs changed'):
                builder.save('built')
            self.assertEqual(build.read_json(builder.state_path)['stage'], 'fetched')

    def test_patch_is_applied_inside_a_parent_git_repository(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        tree = self.root / 'extracted-source'
        tree.mkdir()
        target = tree / 'sample.txt'
        target.write_text('before\n')
        patch_file = self.root / 'change.patch'
        patch_file.write_text('diff --git a/sample.txt b/sample.txt\n'
                              '--- a/sample.txt\n+++ b/sample.txt\n'
                              '@@ -1 +1 @@\n-before\n+after\n')
        build.run(['git', 'apply', '--check', str(patch_file)], tree)
        build.run(['git', 'apply', str(patch_file)], tree)
        self.assertEqual(target.read_text(), 'after\n')

    def test_cached_download_requires_matching_hash(self):
        archive = self.root / 'cached.tar'
        archive.write_bytes(b'trusted cached source')
        expected = build.digest(archive)
        with patch.object(build.urllib.request, 'urlopen') as network:
            build.download('https://example.invalid/source', archive, expected, 100)
            archive.write_bytes(b'changed source')
            with self.assertRaises(build.BuildError):
                build.download('https://example.invalid/source', archive, expected, 100)
            network.assert_not_called()

    def test_native_build_requires_traversed_source_linked_object_and_elf(self):
        source = self.root / 'source'
        obj = self.native_graph(source)
        build.verify_native_build(source)
        mutations = [
            ('backend.RecursiveMakeBackend.in', 'different/moz.build\n'),
            ('camoucfg/backend.mk', 'CPPSRCS += $(srcdir)/Different.cpp\n'),
            ('toolkit/library/build/backend.mk', 'libxul.so_OBJS := unrelated.list\n'),
            ('toolkit/library/build/libxul_so.list', '../../../other/HBrowserStartup.o\n'),
            ('camoucfg/HBrowserStartup.o', 'not a compiled object'),
        ]
        for relative, replacement in mutations:
            path = obj / relative
            original = path.read_bytes()
            with self.subTest(file=relative):
                path.write_text(replacement)
                with self.assertRaises(build.BuildError):
                    build.verify_native_build(source)
                path.unlink()
                with self.assertRaises(build.BuildError):
                    build.verify_native_build(source)
                path.write_bytes(original)
        (obj / 'camoucfg/HBrowserStartup.o').unlink()
        build.verify_native_build(source, require_object=False)

    def test_packaging_refuses_unwired_native_startup_before_running_mach(self):
        workspace = self.root / 'workspace'
        workspace.mkdir()
        builder = build.Builder(workspace)
        builder.save('built')
        with patch.object(build, 'run') as command:
            with self.assertRaisesRegex(build.BuildError, 'native build'):
                builder.package(self.root / 'releases')
            command.assert_not_called()
        self.assertEqual(builder.state()['stage'], 'built')

    def test_build_checks_graph_before_compiling_and_object_before_success(self):
        workspace = self.root / 'workspace'
        workspace.mkdir()
        builder = build.Builder(workspace)
        builder.save('bootstrapped')
        with patch.object(build, 'run') as command, patch.object(build, 'require_build_host'):
            with self.assertRaisesRegex(build.BuildError, 'native build'):
                builder.build(2)
            self.assertEqual([call.args[0] for call in command.call_args_list], [['./mach', 'configure']])
            self.assertEqual(builder.state()['stage'], 'bootstrapped')
            obj = self.native_graph(builder.source)
            (obj / 'camoucfg/HBrowserStartup.o').unlink()
            command.reset_mock()
            with self.assertRaisesRegex(build.BuildError, 'native build object'):
                builder.build(2)
            self.assertEqual([call.args[0] for call in command.call_args_list],
                             [['./mach', 'configure'], ['./mach', 'build', '-j', '2']])
            self.assertEqual(builder.state()['stage'], 'bootstrapped')

    def test_packaging_covers_native_sources_resources_and_notices(self):
        workspace = self.root / 'workspace'
        workspace.mkdir()
        builder = build.Builder(workspace)
        self.native_graph(builder.source)
        dist = builder.source / 'obj-hbrowser/dist'
        dist.mkdir(parents=True)
        (builder.source / 'mozconfig').write_text('fixture configuration\n')
        settings = builder.upstream / 'settings'
        settings.mkdir()
        for resource in ('properties.json', 'chrome.css'):
            (settings / resource).write_text('fixture resource')
        (builder.upstream / 'LICENSE').write_text('fixture license')
        notices = builder.upstream / 'additions/juggler/input/cursory'
        notices.mkdir(parents=True)
        for name in ('NOTICE', 'LICENSE'):
            (notices / name).write_text('fixture notice')
        product, _ = self.product()
        (product / 'hbrowser-build.json').unlink()
        shutil.rmtree(product / 'provenance')
        (product / 'libxul.so').write_bytes(b'SYNTHETIC TEST LIBRARY HBROWSER_CONFIG_FILE')
        with tarfile.open(dist / 'camoufox-fixture.tar.xz', 'w:xz') as archive:
            archive.add(product, arcname='camoufox')
        builder.save('built')
        with patch.object(build, 'run') as command:
            archive = builder.package(self.root / 'releases')
            command.assert_called_once_with(['./mach', 'package'], builder.source)
        destination = self.root / 'installed-fixture'
        build.install(archive, build.digest(archive), destination)
        manifest = build.verify_product(destination)
        files = {entry['path'] for entry in manifest['files']}
        self.assertIn('provenance/native/HBrowserStartup.cpp', files)
        self.assertIn('licenses/Cursory-LICENSE.txt', files)
        self.assertIn('properties.json', files)
        self.assertEqual(builder.state()['stage'], 'packaged')


if __name__ == '__main__':
    unittest.main()
