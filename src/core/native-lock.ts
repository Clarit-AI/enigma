import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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

/**
 * The host's platform/arch, bound at MODULE EVALUATION. process.platform is
 * a process-lifetime constant in production; binding it here also keeps test
 * suites that stub `process.platform` (the macOS native-dialog suites run
 * `Object.defineProperty(process, 'platform', { value: 'darwin' })` in
 * beforeEach) from redirecting addon selection — the index lock is a HOST
 * facility and always loads the artifact for the machine the process runs
 * on. Per-call evaluation would make such a test dlopen a Mach-O on Linux
 * ("invalid ELF header") or vice versa.
 */
const HOST_TAG = `${process.platform}-${process.arch}`;

export function nativeTargetTag(): string {
  return HOST_TAG;
}

let cached: IndexLockAddon | undefined;

interface ArtifactLocation {
  path: string;
  /** Where the location came from — surfaced in failure messages. */
  origin: 'ENIGMA_NATIVE_DIR' | 'installed package layout' | 'source-tree layout';
}

/**
 * The ONE artifact location for the executing module's own layout — or none.
 * There is deliberately no candidate list and no existence probing across
 * roots: a missing artifact in the executing package must surface as
 * E_LOCK_UNAVAILABLE, never silently substitute an addon found in a foreign
 * checkout, the cwd, or an ancestor directory. The native code and the JS
 * lock protocol are versioned together, so an addon belonging to a different
 * tree can be incompatible with this build.
 *
 *   - ENIGMA_NATIVE_DIR set → <dir>/<tag>/index-lock.node, AUTHORITATIVE:
 *     the only location consulted. An absent/corrupt artifact there fails
 *     closed; the override is never masked by searching elsewhere.
 *   - module inside `<pkg>/dist/` (bundled install: .mcp.json / bin run
 *     plugins/enigma/dist/*.mjs) → sibling `<pkg>/native/<tag>/`.
 *   - module at `<repo>/src/core/` (source tree: vitest, dev runs) →
 *     `<repo>/plugins/enigma/native/<tag>/`.
 *   - anything else → undefined: the layout is not a package we shipped, so
 *     there is no artifact location to trust (set ENIGMA_NATIVE_DIR).
 */
function artifactLocation(tag: string): ArtifactLocation | undefined {
  const override = process.env.ENIGMA_NATIVE_DIR;
  if (override) {
    return { path: resolve(override, tag, 'index-lock.node'), origin: 'ENIGMA_NATIVE_DIR' };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  if (basename(here) === 'dist') {
    return { path: resolve(here, '..', 'native', tag, 'index-lock.node'), origin: 'installed package layout' };
  }
  if (basename(here) === 'core' && basename(dirname(here)) === 'src') {
    return {
      path: resolve(here, '..', '..', 'plugins', 'enigma', 'native', tag, 'index-lock.node'),
      origin: 'source-tree layout',
    };
  }
  return undefined;
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
  const artifact = artifactLocation(tag);
  if (!artifact) {
    throw new EnigmaError({
      code: 'E_LOCK_UNAVAILABLE',
      message:
        `Enigma's index lock cannot locate a native artifact for ${tag}: this module ` +
        `(${fileURLToPath(import.meta.url)}) is not in a recognized layout ` +
        '(installed <pkg>/dist or the <repo>/src/core source tree). ' +
        'Set ENIGMA_NATIVE_DIR to the directory containing the per-platform artifacts; ' +
        'refusing to run without kernel-held exclusion.',
    });
  }
  if (!existsSync(artifact.path)) {
    throw new EnigmaError({
      code: 'E_LOCK_UNAVAILABLE',
      message:
        `Enigma's index lock artifact for ${tag} is missing (expected at ${artifact.path} ` +
        `via ${artifact.origin}${artifact.origin === 'ENIGMA_NATIVE_DIR' ? ' — the override is authoritative; no other location was searched' : ''}). ` +
        'Reinstall the plugin; refusing to run without kernel-held exclusion.',
    });
  }
  const found = artifact.path;
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
