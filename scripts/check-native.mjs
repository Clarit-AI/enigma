#!/usr/bin/env node
// Validates the **committed** native artifacts (what a marketplace install
// ships) — a fresh rebuild passing its own smoke does not validate those
// bytes, so this check always exercises the committed file:
//
//   1. integrity   — binarySha256 in manifest.json matches the committed bytes
//   2. staleness   — sourceSha256 matches the current native sources
//                    (STALENESS METADATA ONLY — not proof the binary was
//                    built from these sources; builds are not byte-reproducible)
//   3. load        — on the host's own target, dlopen the committed artifact
//                    and exercise tryLockSync/unlockSync against a temp file
//                    (exclusive acquire, second description blocked, unlock)
//   4. linux libc  — the linux manifest carries a glibc symbol-version audit
//
// Exits non-zero on any failure. No network, no rebuild.
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryArch, TARGET_ARCH } from './lib/binary-arch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_SRC = join(ROOT, 'native');
const OUT_ROOT = join(ROOT, 'plugins', 'enigma', 'native');
const REQUIRED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64'];
const SOURCE_FILES = [
  'include/js_native_api.h',
  'include/js_native_api_types.h',
  'include/node_api.h',
  'include/node_api_types.h',
  'index-lock.cc',
];

const problems = [];
const require = createRequire(import.meta.url);

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

for (const target of REQUIRED_TARGETS) {
  const dir = join(OUT_ROOT, target);
  const binPath = join(dir, 'index-lock.node');
  const manPath = join(dir, 'manifest.json');
  if (!existsSync(binPath) || !existsSync(manPath)) {
    problems.push(`${target}: missing committed artifact or manifest (run scripts/build-native.mjs --target ${target})`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manPath, 'utf8'));
  } catch (err) {
    problems.push(`${target}: unreadable manifest.json: ${err.message}`);
    continue;
  }

  // 1. Integrity of the SHIPPED bytes + machine-type gate (a wrong-arch
  //    binary passes every digest check and only fails at dlopen time —
  //    this catches it on every platform's runner).
  const binBytes = readFileSync(binPath);
  const actualBin = sha256(binBytes);
  const arch = binaryArch(binBytes);
  if (arch !== TARGET_ARCH[target]) {
    problems.push(
      `${target}: binary is ${arch} but the target requires ${TARGET_ARCH[target]} ` +
        '(wrong-arch cross-build — e.g. Docker defaulted to the host arch)',
    );
  }
  if (actualBin !== manifest.binarySha256) {
    problems.push(
      `${target}: committed index-lock.node does not match manifest.binarySha256 ` +
        `(${actualBin} != ${manifest.binarySha256}) — artifact corrupted or hand-edited`,
    );
  }

  // 2. Staleness metadata (explicitly NOT a source/binary correspondence proof).
  const actualSrc = sourceDigest();
  if (actualSrc !== manifest.sourceSha256) {
    problems.push(
      `${target}: native sources changed since this artifact was built ` +
        `(${actualSrc} != ${manifest.sourceSha256}) — rebuild with scripts/build-native.mjs`,
    );
  }

  // 4. Linux libc compatibility record + no C++ runtime dependency (the
  //    addon is compiled as C; a libstdc++ entry would reintroduce a
  //    per-toolchain GLIBCXX floor that breaks loads on older distros).
  if (target === 'linux-x64' && !manifest.glibc?.maxRequiredSymbolVersion) {
    problems.push('linux-x64: manifest lacks glibc.maxRequiredSymbolVersion (readelf --version-info audit)');
  }
  const needed = manifest.neededLibs;
  if (target === 'linux-x64') {
    if (!Array.isArray(needed) || needed.length === 0) {
      problems.push('linux-x64: manifest lacks neededLibs (readelf -d NEEDED audit)');
    } else if (needed.some((lib) => /libstdc\+\+|libc\+\+/.test(String(lib)))) {
      problems.push(`linux-x64: artifact links a C++ runtime (${needed.join(', ')}) — compile as C to keep the libc-only dependency floor`);
    }
  }

  // 3. Load + smoke the COMMITTED artifact — host target only.
  if (target === `${process.platform}-${process.arch}`) {
    try {
      const addon = require(binPath);
      if (typeof addon.tryLockSync !== 'function' || typeof addon.unlockSync !== 'function') {
        problems.push(`${target}: committed artifact does not export tryLockSync/unlockSync`);
      } else {
        const tmp = mkdtempSync(join(tmpdir(), 'enigma-native-check-'));
        const probe = join(tmp, 'probe.lock');
        writeSync(openSync(probe, 'w', 0o600), '');
        const fd1 = openSync(probe, 'r+');
        const fd2 = openSync(probe, 'r+');
        if (addon.tryLockSync(fd1) !== true) {
          problems.push(`${target}: tryLockSync on a free file returned false`);
        }
        if (addon.tryLockSync(fd2) !== false) {
          problems.push(`${target}: tryLockSync did NOT block a second open description — exclusion broken`);
        }
        addon.unlockSync(fd1);
        if (addon.tryLockSync(fd2) !== true) {
          problems.push(`${target}: tryLockSync failed after unlock`);
        }
        addon.unlockSync(fd2);
        closeSync(fd1);
        closeSync(fd2);
        rmSync(tmp, { recursive: true, force: true });
        console.log(`check-native: ${target} committed artifact loaded and passed lock/unlock smoke`);
      }
    } catch (err) {
      problems.push(`${target}: dlopen/smoke of the committed artifact failed: ${err.message}`);
    }
  } else {
    console.log(`check-native: ${target} committed artifact integrity+staleness ok (load smoke runs on that platform's CI runner)`);
  }
}

if (problems.length > 0) {
  console.error('check-native: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-native: OK');
