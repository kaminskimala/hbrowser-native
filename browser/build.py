#!/usr/bin/env python3
"""Build HBrowser from pinned Camoufox and Firefox sources (Linux x64)."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
GIB = 1024 ** 3


class BuildError(Exception):
    pass


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path: Path) -> dict:
    result = json.loads(path.read_text())
    if not isinstance(result, dict):
        raise BuildError(f'Expected a JSON object: {path.name}')
    return result


def write_json(path: Path, value: dict) -> None:
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix=path.name + '.',
                                     suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write('\n')
            stream.flush()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def inputs() -> dict:
    paths = [ROOT / 'engine.lock.json', ROOT / 'build.py']
    paths += sorted((ROOT / 'patches').glob('*.patch'))
    paths += sorted(p for p in (ROOT / 'native').glob('*') if p.is_file())
    return {p.relative_to(ROOT).as_posix(): digest(p) for p in paths}


def nearest_existing(path: Path) -> Path:
    while not path.exists():
        path = path.parent
    return path


def preflight(workspace: Path, minimum_gib: int = 40) -> dict:
    free = shutil.disk_usage(nearest_existing(workspace)).free
    required = ('git', 'make', 'patch', 'tar', 'bash', 'g++')
    tools = {name: shutil.which(name) for name in required}
    supported = sys.platform == 'linux' and platform.machine() in ('x86_64', 'AMD64')
    python_ok = sys.version_info >= (3, 12)
    return {'platformSupported': supported, 'pythonSupported': python_ok,
            'freeGiB': round(free / GIB, 2), 'requiredFreeGiB': minimum_gib,
            'diskReady': free >= minimum_gib * GIB, 'tools': tools,
            'ready': supported and python_ok and free >= minimum_gib * GIB and all(tools.values()),
            'browserLaunchValidated': False}


def require_build_host(workspace: Path, minimum_gib: int = 40) -> None:
    report = preflight(workspace, minimum_gib)
    if not report['ready']:
        raise BuildError('Build prerequisites missing: ' + json.dumps(report, sort_keys=True))


@contextlib.contextmanager
def own_workspace(path: Path):
    if path.is_symlink():
        raise BuildError('Workspace cannot be a symbolic link')
    marker = path / '.hbrowser-workspace.json'
    lock_path = path / '.build.lock'
    if marker.is_symlink():
        raise BuildError('Workspace marker cannot be a symbolic link')
    if path.exists() and not marker.exists() and any(p != lock_path for p in path.iterdir()):
        raise BuildError('Workspace is nonempty and is not owned by HBrowser; choose an empty directory')
    path.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise BuildError('Workspace lock must be a regular file')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BuildError('Another build owns this workspace') from error
        if marker.is_symlink():
            raise BuildError('Workspace marker cannot be a symbolic link')
        if not marker.exists():
            if any(p != lock_path for p in path.iterdir()):
                raise BuildError('Workspace is nonempty and is not owned by HBrowser')
            write_json(marker, {'schemaVersion': 1, 'product': 'HBrowser'})
        elif read_json(marker) != {'schemaVersion': 1, 'product': 'HBrowser'}:
            raise BuildError('Workspace marker is invalid')
        yield
    finally:
        os.close(descriptor)


def download(url: str, destination: Path, expected: str, max_bytes: int) -> None:
    if destination.exists():
        if destination.is_symlink() or digest(destination) != expected:
            raise BuildError(f'Cached input failed its checksum: {destination.name}')
        return
    if not url.startswith('https://'):
        raise BuildError('Downloads require HTTPS')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.partial')
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'HBrowser-build/0.2'})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open('xb') as output:
            if not response.url.startswith('https://'):
                raise BuildError('Download redirected outside HTTPS')
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise BuildError('Download exceeded its size limit')
                output.write(chunk)
        if digest(temporary) != expected:
            raise BuildError(f'Download checksum mismatch: {destination.name}')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def extract(archive: Path, destination: Path, max_bytes: int) -> Path:
    """Extract one confined source/package root; reject special files and escaping links."""
    with tarfile.open(archive, 'r:*') as source:
        members = source.getmembers()
        total = 0
        roots: set[str] = set()
        entries: dict[PurePosixPath, tarfile.TarInfo] = {}
        for member in members:
            # Mozilla source archives include this container marker. Exclude it
            # from extraction so its metadata cannot change the destination.
            if member.name in ('.', './') and member.isdir() and member.size == 0:
                continue
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts:
                raise BuildError('Archive contains an unsafe path')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise BuildError('Archive contains a special file')
            if path in entries:
                raise BuildError('Archive contains duplicate paths')
            entries[path] = member
            total += member.size
            if total > max_bytes:
                raise BuildError('Archive exceeds its extraction limit')
            roots.add(path.parts[0])
        if len(roots) != 1:
            raise BuildError('Archive must contain a single root directory')
        root_name = next(iter(roots))
        for path, member in entries.items():
            if any(parent in entries and not entries[parent].isdir() for parent in path.parents):
                raise BuildError('Archive writes through a file or link')
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                if member.issym():
                    target = path.parent / target
                resolved = PurePosixPath(posixpath.normpath(target.as_posix()))
                if resolved.is_absolute() or not resolved.parts or resolved.parts[0] != root_name:
                    raise BuildError('Archive contains a link outside its root')
        source.extractall(destination, members=entries.values(), filter='data')
    root = destination / roots.pop()
    if not root.is_dir() or root.is_symlink():
        raise BuildError('Archive root is not a directory')
    return root


def run(command: list[str], cwd: Path, extra_env: dict | None = None) -> None:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('HCAPTCHA_', 'HB_', 'HBROWSER_', 'CAMOU_'))}
    env['BUILD_TARGET'] = 'linux,x86_64'
    env.update(extra_env or {})
    # An extracted tree may sit inside the caller's Git checkout. In that case
    # git apply otherwise reports success while silently skipping every patch.
    if command[0] == 'git':
        for variable in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
            env.pop(variable, None)
        env['GIT_CEILING_DIRECTORIES'] = str(cwd.resolve().parent)
    print('+ ' + ' '.join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True, stdin=subprocess.DEVNULL)


class Builder:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.expected_inputs = inputs()
        self.lock = read_json(ROOT / 'engine.lock.json')
        self.upstream = workspace / 'upstream'
        version = self.lock['upstream']['firefoxVersion']
        release = self.lock['upstream']['release']
        self.source = self.upstream / f'camoufox-{version}-{release}'
        self.state_path = workspace / 'state.json'

    def check_inputs(self) -> None:
        if inputs() != self.expected_inputs:
            raise BuildError('Build inputs changed during this command; use a new workspace')

    def state(self, minimum: str | None = None) -> dict:
        self.check_inputs()
        state = read_json(self.state_path) if self.state_path.exists() else {}
        if state and state.get('inputs') != self.expected_inputs:
            raise BuildError('Build inputs changed; use a new workspace to preserve the previous build')
        stages = ['fetched', 'prepared', 'bootstrapped', 'built', 'packaged']
        if minimum and (state.get('stage') not in stages or stages.index(state['stage']) < stages.index(minimum)):
            raise BuildError(f'This command requires stage {minimum}')
        return state

    def save(self, stage: str) -> None:
        self.check_inputs()
        write_json(self.state_path, {'stage': stage, 'inputs': self.expected_inputs,
                                    'engineRevision': self.lock['upstream']['revision']})

    def fetch(self) -> None:
        if self.state().get('stage'):
            return
        if shutil.disk_usage(nearest_existing(self.workspace)).free < GIB:
            raise BuildError('Fetching engine sources requires at least 1 GiB of free disk space')
        if self.upstream.exists():
            raise BuildError('Untracked upstream tree exists; use a new workspace')
        pin = self.lock['upstream']
        name = f"camoufox-{pin['revision']}.tar.gz"
        archive = self.workspace / 'cache' / name
        cached = ROOT / 'cache' / name
        if not archive.exists() and cached.is_file() and digest(cached) == pin['sha256']:
            archive.parent.mkdir(exist_ok=True)
            shutil.copyfile(cached, archive)
        download(pin['archive'], archive, pin['sha256'], 128 * 1024 ** 2)
        with tempfile.TemporaryDirectory(dir=self.workspace) as temporary:
            tree = extract(archive, Path(temporary), 512 * 1024 ** 2)
            patches = sorted((ROOT / 'patches').glob('*.patch'))
            if not patches or not (ROOT / 'native' / 'HBrowserConfigFile.hpp').is_file():
                raise BuildError('HBrowser native sources and patches are required')
            for patch in patches:
                run(['git', 'apply', '--check', str(patch)], tree)
                run(['git', 'apply', str(patch)], tree)
            for native in sorted((ROOT / 'native').iterdir()):
                if native.is_file():
                    shutil.copyfile(native, tree / 'additions' / 'camoucfg' / native.name)
            expected = f"version={pin['firefoxVersion']}\nrelease={pin['release']}"
            if (tree / 'upstream.sh').read_text().strip() != expected:
                raise BuildError('Pinned upstream Firefox version does not match the lock')
            self.check_inputs()
            rename_noreplace(tree, self.upstream)
        self.save('fetched')

    def prepare(self) -> None:
        require_build_host(self.workspace)
        self.fetch()
        if self.state()['stage'] != 'fetched':
            return
        if self.source.exists():
            raise BuildError('Source preparation was interrupted; use a fresh workspace, without erasing this tree')
        pin = self.lock['firefox']
        version = self.lock['upstream']['firefoxVersion']
        release = self.lock['upstream']['release']
        archive = self.workspace / 'cache' / f'firefox-{version}.source.tar.xz'
        download(pin['archive'], archive, pin['sha256'], 2 * GIB)
        with tempfile.TemporaryDirectory(dir=self.workspace) as temporary:
            tree = extract(archive, Path(temporary), 12 * GIB)
            if not (tree / 'configure.py').is_file():
                raise BuildError('Firefox source archive lacks configure.py')
            tree.rename(self.source)
        run(['bash', '../scripts/copy-additions.sh', version, release], self.source)
        run([sys.executable, 'scripts/patch.py', version, release], self.upstream)
        with (self.source / 'mozconfig').open('a') as config:
            config.write('\n# HBrowser uses one explicit object directory for build and packaging.\n')
            config.write('mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-hbrowser\n')
        self.save('prepared')

    def bootstrap(self) -> None:
        self.state('prepared')
        require_build_host(self.workspace, 30)
        if self.state()['stage'] == 'prepared':
            run(['./mach', '--no-interactive', 'bootstrap', '--application-choice=browser',
                 '--no-system-changes'], self.source)
            self.save('bootstrapped')

    def build(self, jobs: int) -> None:
        self.state('bootstrapped')
        require_build_host(self.workspace, 30)
        run(['./mach', 'configure'], self.source)
        verify_native_build(self.source, require_object=False)
        run(['./mach', 'build', '-j', str(jobs)], self.source, {'CARGO_BUILD_JOBS': str(jobs)})
        verify_native_build(self.source)
        self.save('built')

    def package(self, output: Path) -> Path:
        self.state('built')
        verify_native_build(self.source)
        run(['./mach', 'package'], self.source)
        archives = sorted((self.source / 'obj-hbrowser' / 'dist').glob('camoufox-*.tar.*'))
        if len(archives) != 1:
            raise BuildError('Expected exactly one mach browser package')
        output.mkdir(parents=True, exist_ok=True)
        name = f"hbrowser-{self.lock['version']}-linux-x64"
        destination = output / f'{name}.tar.xz'
        checksum = destination.with_name(destination.name + '.sha256')
        if destination.exists() or checksum.exists():
            raise BuildError('Release already exists; choose a new output directory')
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            base = Path(temporary)
            original = extract(archives[0], base / 'unpacked', 4 * GIB)
            for path in original.rglob('*'):
                if path.is_symlink() and not path.resolve().is_relative_to(original.resolve()):
                    raise BuildError('Package contains a link outside the product')
            product = base / name
            shutil.copytree(original, product, symlinks=False)
            for required in ('camoufox-bin', 'libxul.so'):
                if not (product / required).is_file():
                    raise BuildError(f'Compiled browser lacks {required}')
            if not contains_bytes(product / 'libxul.so', b'HBROWSER_CONFIG_FILE'):
                raise BuildError('Compiled library does not contain the HBrowser native configuration feature')
            for resource in ('properties.json', 'chrome.css'):
                shutil.copyfile(self.upstream / 'settings' / resource, product / resource)
            provenance = product / 'provenance'
            provenance.mkdir()
            shutil.copyfile(ROOT / 'engine.lock.json', provenance / 'engine.lock.json')
            shutil.copyfile(self.state_path, provenance / 'build-state.json')
            shutil.copyfile(self.source / 'mozconfig', provenance / 'mozconfig')
            shutil.copytree(ROOT / 'patches', provenance / 'patches')
            shutil.copytree(ROOT / 'native', provenance / 'native')
            notices = product / 'licenses'
            notices.mkdir(exist_ok=True)
            shutil.copyfile(self.upstream / 'LICENSE', notices / 'Camoufox-MPL-2.0.txt')
            cursory = self.upstream / 'additions/juggler/input/cursory'
            for filename in ('NOTICE', 'LICENSE'):
                shutil.copyfile(cursory / filename, notices / f'Cursory-{filename}.txt')
            patches = [{'path': f'provenance/patches/{p.name}', 'sha256': digest(p)}
                       for p in sorted((ROOT / 'patches').glob('*.patch'))]
            files = [{'path': p.relative_to(product).as_posix(), 'sha256': digest(p)}
                     for p in sorted(product.rglob('*')) if p.is_file()]
            manifest = {'schemaVersion': 1, 'product': 'HBrowser', 'version': self.lock['version'],
                        'platform': 'linux', 'arch': 'x64', 'executable': 'camoufox-bin',
                        'engine': {'name': 'camoufox', 'revision': self.lock['upstream']['revision'],
                                   'firefoxVersion': self.lock['upstream']['firefoxVersion']},
                        'patches': patches, 'files': files}
            write_json(product / 'hbrowser-build.json', manifest)
            verify_product(product)
            packed = base / destination.name
            with tarfile.open(packed, 'w:xz', dereference=True) as archive:
                archive.add(product, arcname=name)
            self.check_inputs()
            rename_noreplace(packed, destination)
        with checksum.open('x') as stream:
            stream.write(f'{digest(destination)}  {destination.name}\n')
        self.save('packaged')
        return destination


def verify_native_build(source: Path, *, require_object: bool = True) -> None:
    """Require the startup source in the generated graph and libxul linker inputs."""
    source = source.resolve()
    obj = source / 'obj-hbrowser'

    def read(relative: str) -> str:
        path = obj / relative
        if not path.is_file():
            raise BuildError(f'Missing native build evidence: {relative}')
        return path.read_text()

    inputs = read('backend.RecursiveMakeBackend.in').splitlines()
    if str(source / 'camoucfg/moz.build') not in inputs:
        raise BuildError('Invalid native build graph: camoucfg/moz.build was not traversed')
    backend = read('camoucfg/backend.mk')
    sources = [token for line in backend.splitlines() if line.startswith('CPPSRCS += ')
               for token in line.removeprefix('CPPSRCS += ').split()]
    if '$(srcdir)/HBrowserStartup.cpp' not in sources:
        raise BuildError('Invalid native build graph: HBrowserStartup.cpp is not compiled')

    linker = obj / 'toolkit/library/build'
    response = linker / 'libxul_so.list'
    if f'libxul.so_OBJS := -Wl,@{response}' not in read('toolkit/library/build/backend.mk').splitlines():
        raise BuildError('Invalid native build graph: libxul does not consume its object list')
    compiled = obj / 'camoucfg/HBrowserStartup.o'
    linked_objects = {(linker / entry).resolve()
                      for entry in shlex.split(read('toolkit/library/build/libxul_so.list'))}
    if compiled not in linked_objects:
        raise BuildError('Invalid native build graph: libxul does not link HBrowserStartup.o')

    if require_object:
        if compiled.is_symlink() or not compiled.is_file() or compiled.stat().st_size <= 64:
            raise BuildError('Missing native build object: HBrowserStartup.o')
        with compiled.open('rb') as stream:
            header = stream.read(64)
        if header[:6] != b'\x7fELF\x02\x01' or header[16:20] != b'\x01\x00\x3e\x00':
            raise BuildError('Invalid native build object: expected an ELF64 x86-64 relocatable object')


def contains_bytes(path: Path, needle: bytes) -> bool:
    tail = b''
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            content = tail + chunk
            if needle in content:
                return True
            tail = content[-len(needle):]
    return False


def valid_product_path(value: object) -> bool:
    return (isinstance(value, str) and bool(value) and not re.search(r'[\\\x00-\x1f:]', value)
            and all(part not in ('', '.', '..') for part in value.split('/')))


def manifest_entries(value: object) -> bool:
    return (isinstance(value, list) and bool(value) and all(
        isinstance(entry, dict) and valid_product_path(entry.get('path'))
        and entry['path'] != 'hbrowser-build.json'
        and isinstance(entry.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', entry['sha256'])
        for entry in value))


def verify_product(root: Path) -> dict:
    if root.is_symlink() or not root.is_dir():
        raise BuildError('Product root must be a directory, not a symbolic link')
    manifest_path = root / 'hbrowser-build.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise BuildError('Manifest must be a regular file, not a symlink')
    if manifest_path.stat().st_size > 4 * 1024 ** 2:
        raise BuildError('Manifest exceeds the 4 MiB limit')
    manifest = read_json(manifest_path)
    engine = manifest.get('engine')
    if (manifest.get('schemaVersion') != 1 or manifest.get('product') != 'HBrowser'
            or manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64'
            or not isinstance(manifest.get('version'), str)
            or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', manifest['version'], re.ASCII)
            or not isinstance(engine, dict) or engine.get('name') != 'camoufox'
            or not isinstance(engine.get('revision'), str) or not re.fullmatch('[0-9a-f]{40}', engine['revision'])
            or not isinstance(engine.get('firefoxVersion'), str)
            or not re.fullmatch(r'\d+\.\d+(?:\.\d+)?(?:[a-z]\d+)?', engine['firefoxVersion'], re.ASCII)
            or not valid_product_path(manifest.get('executable'))
            or not manifest_entries(manifest.get('files')) or not manifest_entries(manifest.get('patches'))):
        raise BuildError('Not a supported HBrowser package')
    declared: dict[str, str] = {}
    for entry in manifest.get('files', []):
        relative = entry['path']
        if relative in declared:
            raise BuildError('Invalid or duplicate manifest path')
        target = root / relative
        if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()) or not target.is_file():
            raise BuildError('Manifest file is not a regular confined file')
        if digest(target) != entry['sha256']:
            raise BuildError(f'Package file failed its checksum: {relative}')
        declared[relative] = entry['sha256']
    actual = set()
    for path in root.rglob('*'):
        relative = path.relative_to(root).as_posix()
        if (not valid_product_path(relative) or path.is_symlink()
                or not (path.is_file() or path.is_dir())):
            raise BuildError('Package contains a link or special file')
        if path.is_file() and relative != 'hbrowser-build.json':
            actual.add(relative)
    if actual != set(declared):
        raise BuildError('Package manifest does not cover every file')
    executable = manifest.get('executable')
    if executable not in declared or 'libxul.so' not in declared:
        raise BuildError('Package lacks its compiled executable or engine')
    if not os.access(root / executable, os.X_OK):
        raise BuildError('Browser executable lacks execute permission')
    patches = manifest.get('patches')
    if (len({p['path'] for p in patches}) != len(patches)
            or any(not p['path'].startswith('provenance/patches/')
                   or declared.get(p['path']) != p['sha256'] for p in patches)):
        raise BuildError('Native patches are not covered by the manifest')
    return manifest


def rename_noreplace(source: Path, destination: Path) -> None:
    """Publish atomically without replacing a destination created by another process."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError as error:
        raise BuildError('Atomic installation requires Linux renameat2 support') from error
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    # AT_FDCWD and RENAME_NOREPLACE are Linux ABI constants.
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(destination))


def install(archive: Path, expected: str, destination: Path) -> None:
    if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
        raise BuildError('Supply the SHA-256 from a trusted build or release')
    if digest(archive) != expected:
        raise BuildError('Installation archive checksum mismatch')
    if destination.exists() or destination.is_symlink():
        raise BuildError('Installation destination already exists; install each version into a new directory')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        product = extract(archive, Path(temporary), 4 * GIB)
        verify_product(product)
        rename_noreplace(product, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=ROOT / 'work')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('doctor', 'fetch', 'prepare', 'bootstrap'):
        commands.add_parser(name)
    for name in ('build', 'all'):
        command = commands.add_parser(name)
        command.add_argument('--jobs', type=int, choices=range(1, 33), default=2)
        if name == 'all':
            command.add_argument('--out', type=Path, default=ROOT / 'releases')
    package = commands.add_parser('package')
    package.add_argument('--out', type=Path, default=ROOT / 'releases')
    installer = commands.add_parser('install')
    installer.add_argument('archive', type=Path)
    installer.add_argument('--sha256', required=True)
    installer.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'doctor':
        report = preflight(args.workspace)
        print(json.dumps(report, indent=2))
        return 0 if report['ready'] else 2
    if args.command == 'install':
        install(args.archive, args.sha256, args.destination)
        print(f'Installed HBrowser: {args.destination}')
        return 0
    with own_workspace(args.workspace):
        builder = Builder(args.workspace.resolve())
        if args.command == 'all':
            builder.prepare()
            builder.bootstrap()
            builder.build(args.jobs)
            print(builder.package(args.out.resolve()))
        elif args.command == 'build':
            builder.build(args.jobs)
        elif args.command == 'package':
            print(builder.package(args.out.resolve()))
        else:
            getattr(builder, args.command)()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (BuildError, OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f'HBrowser build: {error}', file=sys.stderr)
        raise SystemExit(1)
