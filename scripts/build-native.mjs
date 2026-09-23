#!/usr/bin/env node
// Builds the first-party index-lock N-API addon into
// plugins/enigma/native/<os>-<arch>/index-lock.node and writes a
// provenance manifest.json beside it.
//
// Targets: darwin-arm64, darwin-x64 (cross-compiled with -arch on macOS),
// linux-x64 (cross-compiled in Docker from any host). Host target is the
// default. The addon is compiled AS C (-x c) despite the .cc suffix so it
// links ONLY libc — no libstdc++/GLIBCXX dependency at all (flock(2) +
// N-API need nothing else), which keeps the linux compatibility floor a
// single auditable glibc symbol version.
//
// Native builds are NOT byte-reproducible across toolchains; the manifest
// records binarySha256 (pins the shipped bytes) and sourceSha256 (staleness
// metadata — see native/PROVENANCE.md).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_SRC = join(ROOT, 'native');
const OUT_ROOT = join(ROOT, 'plugins', 'enigma', 'native');
const SOURCE_FILES = [
  'index-lock.cc',
  'include/js_native_api.h',
  'include/js_native_api_types.h',
  'include/node_api.h',
  'include/node_api_types.h',
];
const LINUX_DOCKER_IMAGE = 'node:20-bookworm';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sourceDigest() {
  const hash = createHash('sha256');
  for (const rel of [...SOURCE_FILES].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(NATIVE_SRC, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hostTag() {
  return `${process.platform}-${process.arch}`;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = argValue('--target') ?? hostTag();
if (!['darwin-arm64', 'darwin-x64', 'linux-x64'].includes(target)) {
  console.error(`build-native: unsupported target ${target} (supported: darwin-arm64, darwin-x64, linux-x64)`);
  process.exit(1);
}

const outDir = join(OUT_ROOT, target);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'index-lock.node');

const macArgs = (arch) => [
  '-x', 'c',
  '-std=c11',
  '-O2',
  '-fPIC',
  '-arch', arch,
  '-bundle',
  '-undefined', 'dynamic_lookup',
  '-DNAPI_VERSION=8',
  '-I', 'native/include',
  '-o', outFile,
  'native/index-lock.cc',
];
const linuxCompile = [
  'gcc', '-x', 'c', '-std=c11', '-O2', '-fPIC', '-shared',
  '-DNAPI_VERSION=8',
  '-I', 'native/include',
  '-o', '/out/index-lock.node',
  'native/index-lock.cc',
].join(' ');

let command;
let toolchain;
let buildHost;
let glibcAudit;
let neededLibs;

if (target.startsWith('darwin-')) {
  const arch = target === 'darwin-arm64' ? 'arm64' : 'x86_64';
  const args = macArgs(arch);
  command = `clang ${args.join(' ')}`;
  toolchain = execFileSync('clang', ['--version'], { encoding: 'utf8' }).split('\n')[0];
  buildHost = `host ${hostTag()}, macOS cross -arch ${arch}`;
  execFileSync('clang', args, { cwd: ROOT, stdio: 'inherit' });
} else {
  command = `docker run --rm -v ${ROOT}:/src -v ${outDir}:/out -w /src ${LINUX_DOCKER_IMAGE} ${linuxCompile}`;
  // Build + dependency/symbol audits inside the container (readelf comes
  // with the image's toolchain). Output goes straight to the target dir.
  const script = [
    'set -e',
    linuxCompile,
    'echo "TOOLCHAIN:$(gcc --version | head -1)"',
    "echo \"GLIBC:$(readelf --version-info /out/index-lock.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)\"",
    "echo \"NEEDED:$(readelf -d /out/index-lock.node | sed -n 's/.*Shared library: \\[\\(.*\\)\\]/\\1/p' | paste -sd, -)\"",
  ].join(' && ');
  const out = execFileSync(
    'docker',
    ['run', '--rm', '-v', `${ROOT}:/src`, '-v', `${outDir}:/out`, '-w', '/src', LINUX_DOCKER_IMAGE,
      'bash', '-c', script],
    { encoding: 'utf8' },
  );
  toolchain = out.match(/TOOLCHAIN:(.*)/)?.[1]?.trim() ?? 'unknown';
  glibcAudit = out.match(/GLIBC:(.*)/)?.[1]?.trim();
  neededLibs = out.match(/NEEDED:(.*)/)?.[1]?.trim();
  buildHost = `docker ${LINUX_DOCKER_IMAGE}`;
}

const binary = readFileSync(outFile);
const manifest = {
  manifestVersion: 1,
  target,
  napiVersion: 8,
  binary: 'index-lock.node',
  binarySha256: sha256(binary),
  sourceSha256: sourceDigest(),
  sourceFiles: [...SOURCE_FILES].sort(),
  builtAt: new Date().toISOString(),
  builder: 'scripts/build-native.mjs',
  buildCommand: command,
  toolchain,
  buildHost,
  ...(glibcAudit ? { glibc: { maxRequiredSymbolVersion: glibcAudit, audit: 'readelf --version-info' } } : {}),
  ...(neededLibs ? { neededLibs: neededLibs.split(',').filter(Boolean), audit: 'readelf -d (NEEDED)' } : {}),
  notes:
    'sourceSha256 is staleness metadata, not proof the binary came from these sources ' +
    '(builds are not byte-reproducible); binarySha256 pins the shipped bytes. ' +
    'See native/PROVENANCE.md.',
};
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`build-native: ${target} -> ${relative(ROOT, outFile)}`);
console.log(`  binarySha256 ${manifest.binarySha256}`);
console.log(`  sourceSha256 ${manifest.sourceSha256}`);
if (glibcAudit) console.log(`  glibc max ${glibcAudit}`);
if (neededLibs) console.log(`  needed ${neededLibs}`);
