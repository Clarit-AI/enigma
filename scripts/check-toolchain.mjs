#!/usr/bin/env node
// Guard against a stale or wrong-toolchain gate run (Issue #29). `npx <tool>`
// resolves a local node_modules/.bin binary when one exists, but silently
// falls back to a cached or global install when node_modules is empty or
// missing that package — so a lane that runs e.g. `npx vitest run <file>`
// before `npm ci` gets a result from whatever version happens to be cached,
// not the one this repo pins. A green or red result from the wrong
// toolchain is indistinguishable from a real one; this script makes the
// mismatch loud instead of silent.
//
// This only checks what's actually installed in THIS project's
// node_modules against the ranges declared in package.json — it never
// tries to guess which binary a given invocation would have resolved
// (that's what makes it work for both `npm run <script>` and a bare
// `npx vitest` run: see scripts/vitest-toolchain-guard.mjs, wired in as
// vitest's globalSetup, which runs under whatever vitest binary loads this
// repo's config, and reads the same node_modules directly rather than
// asking "which vitest am I").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECKED_PACKAGES = ['vitest', 'typescript', 'eslint'];

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Minimal caret-range check (`^X.Y.Z`) — the only range shape used in this
// repo's devDependencies. Not a general semver implementation on purpose
// (see Issue #29's Out of Scope: this is a cheap pin check, not a
// dependency auditor).
function satisfiesCaretRange(installedVersion, range) {
  if (!range.startsWith('^')) return null;
  const min = parseVersion(range.slice(1));
  const have = parseVersion(installedVersion);
  if (!min || !have) return null;
  if (have[0] !== min[0]) return false;
  if (have[0] === 0) return have[1] === min[1] && have[2] >= min[2];
  if (have[1] !== min[1]) return have[1] > min[1];
  return have[2] >= min[2];
}

/** @param {string} [root] @returns {string[]} human-readable problems, empty if the toolchain checks out */
export function checkToolchain(root = process.cwd()) {
  const problems = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (err) {
    return [`could not read package.json in ${root}: ${err instanceof Error ? err.message : String(err)}`];
  }

  for (const name of CHECKED_PACKAGES) {
    const range = pkg.devDependencies?.[name];
    if (!range) continue;

    let installedVersion;
    try {
      installedVersion = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      problems.push(`${name} (pinned ${range} in package.json) is not installed in node_modules`);
      continue;
    }

    const satisfies = satisfiesCaretRange(installedVersion, range);
    if (satisfies === false) {
      problems.push(`${name} ${installedVersion} in node_modules does not satisfy the pinned range ${range} in package.json`);
    } else if (satisfies === null) {
      problems.push(`${name}: could not compare installed version ${String(installedVersion)} against declared range ${range}`);
    }
  }

  return problems;
}

function formatFailure(problems) {
  return [
    'check-toolchain: FAILED',
    ...problems.map((p) => `  - ${p}`),
    '',
    'node_modules is empty or stale, which means a gate command could silently run against a ' +
      'different toolchain than the one this repo pins (e.g. `npx vitest` falling back to a cached ' +
      'or global install instead of failing — Issue #29). Run `npm ci` before running gate commands.',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkToolchain();
  if (problems.length > 0) {
    console.error(formatFailure(problems));
    process.exit(1);
  }
  console.log('check-toolchain: OK');
}
