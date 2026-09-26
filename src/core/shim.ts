// PATH shim for the bundled `enigma` CLI.
//
// Issue #90. A marketplace install (`claude plugin install enigma@clarit-enigma`) unpacks
// the plugin under Claude Code's plugin root, which is not on the user's PATH.
// The consequence is not cosmetic: read-guard's own denial message tells the
// agent to "use `enigma run -- <command>`", and after the only supported install
// that command does not exist. The one mechanism that keeps a value out of the
// context window is unreachable, which is most of why the plaintext `env`
// depository gets picked instead of `encrypted`.
//
// The fix is a single symlink in a directory that is ALREADY on PATH, so no
// shell rc, no PATH mutation, and no new session is required. The package's
// `bin` entry would do the same thing, but npm distribution is shelved (see the
// Install section of the README).
//
// SessionStart is the only plugin lifecycle event that runs before the agent
// acts, so that is where the shim is placed.
//
// This is a secret manager, so the write is deliberately timid. `ensureCliShim`
// only ever:
//   - considers ABSOLUTE directories that are already on PATH (a relative entry
//     like `./bin` is someone else's project directory, not ours to write into);
//   - replaces an existing `enigma` only when it is a DANGLING symlink, which
//     is safe by construction — nothing can be using a link whose target does
//     not exist, and a dead link is exactly what a plugin upgrade leaves behind;
//   - never touches a regular file, a directory, or a working symlink, so a real
//     `enigma` install further down PATH is reported, not shadowed;
//   - never throws. A hook that throws breaks the user's session.
import { accessSync, constants, existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ShimStatus =
  /** The symlink did not exist and now does. */
  | 'installed'
  /** Already correct — Enigma is on PATH. Nothing was written. */
  | 'present'
  /** A dangling shim (dead plugin root) was re-pointed at the current CLI. */
  | 'repointed'
  /** Something else called `enigma` is on PATH and already resolves. Left alone. */
  | 'occupied'
  /** Opted out via ENIGMA_NO_PATH_SHIM=1. */
  | 'disabled'
  /** Not running from a plugin install, or the CLI bundle is missing. */
  | 'unavailable'
  /** No directory on PATH is writable by this user. */
  | 'no-writable-dir'
  /** Read-only callers only: a session would write the shim here, but was not asked to. */
  | 'pending'
  /** An unexpected fs error. `detail` carries it. */
  | 'failed';

export interface ShimResult {
  status: ShimStatus;
  /** Absolute path of the `enigma` entry, when one exists or was created. */
  target: string | null;
  /** Absolute path of the CLI bundle the shim points at. Null only when unknown. */
  cli: string | null;
  /** What a symlink at `target` points at, when `target` is a symlink. */
  link: string | null;
  /** A short clause explaining a non-OK status. Path/errno text only, never a value. */
  detail: string | null;
}

/** Absolute, de-duplicated PATH entries in PATH order. Relative entries are dropped. */
function pathDirs(pathEnv: string): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of pathEnv.split(delimiter)) {
    const entry = raw.trim();
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const abs = resolve(entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    dirs.push(abs);
  }
  return dirs;
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What currently occupies `<dir>/enigma`. */
type Slot = 'free' | 'dangling' | 'ours' | 'foreign';

function classify(dest: string, cli: string): { slot: Slot; link: string | null } {
  let stats;
  try {
    stats = lstatSync(dest);
  } catch {
    return { slot: 'free', link: null };
  }
  // Not a symlink: a real file, a directory, a socket. Never ours to replace.
  if (!stats.isSymbolicLink()) return { slot: 'foreign', link: null };

  let raw: string;
  try {
    raw = readlinkSync(dest);
  } catch {
    return { slot: 'foreign', link: null };
  }
  const link = isAbsolute(raw) ? resolve(raw) : resolve(dirname(dest), raw);

  let resolves = true;
  try {
    accessSync(link, constants.F_OK);
  } catch {
    resolves = false;
  }
  if (!resolves) return { slot: 'dangling', link };
  return link === cli ? { slot: 'ours', link } : { slot: 'foreign', link };
}

/**
 * Symlink `dest` at `cli` atomically: build the link beside its final name and
 * rename over it, so a concurrent reader sees either the old link or the new
 * one and never a half-written entry.
 */
function linkShim(dest: string, cli: string): boolean {
  const tmp = `${dest}.enigma-tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    symlinkSync(cli, tmp);
    renameSync(tmp, dest);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort — a leftover temp name is inert and gets reused next run
    }
    return false;
  }
}

/**
 * Where the plugin is installed. `CLAUDE_PLUGIN_ROOT` is authoritative inside a
 * hook subprocess. Outside one — `enigma doctor` run as a plain command — the
 * bundle can still locate itself: `dist/{cli,hooks}.mjs` sits two levels below
 * the plugin root, for a marketplace install and for the npm bin alike.
 * Anywhere else (unit tests, say) the inferred root simply has no `dist/cli.mjs`
 * and the caller gets `unavailable` rather than a wrong guess.
 */
export function defaultPluginRoot(): string | null {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) return fromEnv;
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return null;
  }
}

export interface EnsureOptions {
  /** Defaults to `defaultPluginRoot()`. */
  pluginRoot?: string | null;
  /** Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /**
   * False for read-only callers: report what a session *would* do (`pending`)
   * instead of touching the filesystem. `enigma doctor` is a diagnostic and
   * must not change the thing it is diagnosing.
   */
  write?: boolean;
}

/**
 * Put `enigma` on PATH if that can be done without disturbing anything.
 * Never throws; every failure is a `ShimResult` with a non-OK status.
 */
export function ensureCliShim(options: EnsureOptions = {}): ShimResult {
  try {
    if (process.env.ENIGMA_NO_PATH_SHIM === '1') {
      return { status: 'disabled', target: null, cli: null, link: null, detail: 'ENIGMA_NO_PATH_SHIM=1 is set' };
    }

    const pluginRoot = options.pluginRoot === undefined ? defaultPluginRoot() : options.pluginRoot;
    if (!pluginRoot) {
      return { status: 'unavailable', target: null, cli: null, link: null, detail: 'not running from a plugin install' };
    }
    const cli = resolve(pluginRoot, 'dist', 'cli.mjs');
    if (!existsSync(cli)) {
      // `cli` stays null: the path is recorded in `detail` for diagnostics, but
      // it is NOT a usable invocation, and callers like `runHint` must not
      // recommend it. (Under test, the inferred root is `src/`, so this is the
      // branch that keeps the source tree from advertising a phantom binary.)
      return { status: 'unavailable', target: null, cli: null, link: null, detail: `no CLI bundle at ${cli}` };
    }

    const dirs = pathDirs(options.pathEnv ?? process.env.PATH ?? '');
    if (dirs.length === 0) {
      return { status: 'no-writable-dir', target: null, cli, link: null, detail: 'PATH has no absolute directory' };
    }
    const write = options.write !== false;

    // Scan the whole PATH before creating anything, so a working `enigma`
    // further down PATH is reported rather than shadowed by a new link up here.
    let firstFree: string | null = null;
    for (const dir of dirs) {
      const dest = join(dir, 'enigma');
      const { slot, link } = classify(dest, cli);

      if (slot === 'ours') return { status: 'present', target: dest, cli, link, detail: null };
      if (slot === 'foreign') {
        return { status: 'occupied', target: dest, cli, link, detail: `${dest} is not a shim and was left alone` };
      }
      if (slot === 'dangling') {
        if (!isWritableDir(dir)) continue;
        if (!write) return { status: 'pending', target: dest, cli, link: cli, detail: 'a dangling shim would be refreshed here' };
        if (linkShim(dest, cli)) return { status: 'repointed', target: dest, cli, link: cli, detail: null };
        continue;
      }
      if (firstFree === null && isWritableDir(dir)) firstFree = dest;
    }

    if (firstFree === null) {
      return { status: 'no-writable-dir', target: null, cli, link: null, detail: 'no writable directory on PATH' };
    }
    if (!write) return { status: 'pending', target: firstFree, cli, link: null, detail: 'a session would create the shim here' };
    if (!linkShim(firstFree, cli)) {
      return { status: 'failed', target: firstFree, cli, link: null, detail: `could not create ${firstFree}` };
    }
    return { status: 'installed', target: firstFree, cli, link: cli, detail: null };
  } catch (err) {
    return {
      status: 'failed',
      target: null,
      cli: null,
      link: null,
      detail: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

/**
 * The shortest runnable way to invoke the CLI right now, as a snippet ready to
 * drop into a sentence.
 *
 * This exists because the read-guard's denial message is the one instruction an
 * agent is actually given after being blocked. Recommending a command that does
 * not exist turns a correct refusal into a dead end, and that dead end is a
 * large part of how users ended up on the plaintext `env` depository. When the
 * shim is in place the plain form is correct; when it is not, the message names
 * the bundle path that does work.
 *
 * Read-only by construction, and cheap enough to call on a denial: denials are
 * rare, and this deliberately never runs on the allow path.
 */
export function runHint(): string {
  const result = ensureCliShim({ write: false });
  if (result.status === 'present' || result.status === 'repointed') return '`enigma run -- <command>`';
  if (result.cli) return `\`node "${result.cli}" run -- <command>\``;
  return '`enigma run -- <command>`';
}

/**
 * The one line worth telling the session about, or `null` for the statuses
 * that are not news (`present` on every session, `unavailable` outside a plugin
 * install). Safe for `additionalContext`: it names paths and commands, never a
 * value — the same rule the rest of this hook holds to.
 */
export function describeShim(result: ShimResult): string | null {
  switch (result.status) {
    case 'installed':
      return `Enigma: put "enigma" on PATH at ${result.target} so "enigma run" works. If the shell has not picked it up yet, run: hash -r`;
    case 'repointed':
      return `Enigma: refreshed the "enigma" PATH shim at ${result.target} (it pointed at a plugin version that is gone).`;
    case 'occupied':
      return `Enigma: ${result.detail} — "enigma" on your PATH may not be this Enigma. Run this Enigma directly: node "${result.cli ?? ''}"`;
    case 'no-writable-dir':
    case 'failed':
      return `Enigma: could not put "enigma" on PATH (${result.detail}). Run commands through: node "${result.cli ?? ''}" run -- <command>`;
    case 'disabled':
    case 'present':
    case 'unavailable':
      return null;
    case 'pending':
      return `Enigma: "enigma" is not on PATH yet; the next session start will create it at ${result.target}.`;
  }
}
