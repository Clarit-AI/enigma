import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnigmaError } from './errors.js';

/** The only operations the lock core needs from the native addon. */
export interface IndexLockAddon {
  /** `flock(fd, LOCK_EX | LOCK_NB)` — true when acquired, false when another description holds it. */
  tryLockSync(fd: number): boolean;
  /** `flock(fd, LOCK_UN)`. */
  unlockSync(fd: number): void;
}

/** Platforms with a committed artifact under `plugins/enigma/native/<tag>/`. */
export const SUPPORTED_NATIVE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const;

export function nativeTargetTag(): string {
  return `${process.platform}-${process.arch}`;
}

let cached: IndexLockAddon | undefined;

function candidatePaths(tag: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths: string[] = [];
  // 1. Explicit override (tests / exotic installs).
  const override = process.env.ENIGMA_NATIVE_DIR;
  if (override) paths.push(resolve(override, tag, 'index-lock.node'));
  // 2. Marketplace/bundle layout: this module is inside plugins/enigma/dist/,
  //    so the committed artifacts live at ../native/<tag>/index-lock.node.
  paths.push(resolve(here, '..', 'native', tag, 'index-lock.node'));
  // 3. Source-tree layout (vitest runs TS from src/): ../../plugins/enigma/native/<tag>.
  paths.push(resolve(here, '..', '..', 'plugins', 'enigma', 'native', tag, 'index-lock.node'));
  // 4. Repo-root cwd — covers bundles written to a temp dir and spawned from
  //    the repo root (e.g. test/integration/mcp-server.test.ts). Candidate 2
  //    always wins inside a real plugin tree, so this cannot shadow an
  //    installed artifact.
  paths.push(resolve(process.cwd(), 'plugins', 'enigma', 'native', tag, 'index-lock.node'));
  return paths;
}

/**
 * Loads the committed first-party flock addon. Fail-closed with a clear
 * error on unsupported platforms or a missing/corrupt artifact — there is
 * no pure-JS fallback by design (a second lock protocol would be a second
 * proof obligation; see the Issue #66 mechanism decision).
 */
export function loadIndexLock(): IndexLockAddon {
  if (cached) return cached;
  const tag = nativeTargetTag();
  if (!(SUPPORTED_NATIVE_TARGETS as readonly string[]).includes(tag)) {
    throw new EnigmaError({
      code: 'E_LOCK_UNAVAILABLE',
      message:
        `Enigma's index lock has no packaged native artifact for ${tag}; ` +
        `supported platforms: ${SUPPORTED_NATIVE_TARGETS.join(', ')}. ` +
        'Refusing to run without kernel-held exclusion (no fallback protocol).',
    });
  }
  const paths = candidatePaths(tag);
  const found = paths.find((p) => existsSync(p));
  if (!found) {
    throw new EnigmaError({
      code: 'E_LOCK_UNAVAILABLE',
      message:
        `Enigma's index lock artifact for ${tag} is missing (looked for: ${paths.join(', ')}). ` +
        'Reinstall the plugin; refusing to run without kernel-held exclusion.',
    });
  }
  try {
    const addon = createRequire(import.meta.url)(found) as IndexLockAddon;
    if (typeof addon.tryLockSync !== 'function' || typeof addon.unlockSync !== 'function') {
      throw new Error('missing tryLockSync/unlockSync exports');
    }
    cached = addon;
    return addon;
  } catch (err) {
    throw new EnigmaError({
      code: 'E_LOCK_UNAVAILABLE',
      message:
        `Enigma's index lock artifact for ${tag} failed to load (${found}): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Refusing to run without kernel-held exclusion.',
    });
  }
}
