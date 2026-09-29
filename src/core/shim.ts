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
//   - only writes into a directory that is writable by this user and NOT by
//     the world (`/tmp`, a sticky world-writable dir, is not a place to leave
//     an executable that a session will later run). Group-writable is fine:
//     that is a stock macOS `/usr/local/bin`, and refusing it would leave no
//     shim at all;
//   - replaces an existing `enigma` only when it is a DANGLING symlink (safe by
//     construction — nothing can be using a link whose target does not exist,
//     and a dead link is exactly what a plugin upgrade leaves behind) or a
//     symlink to a STRICTLY OLDER Enigma plugin install's CLI that is still on
//     disk (an upgrade that keeps the previous version around leaves this one).
//     A same-version or newer install is never touched, so two installs on one
//     machine (a dev checkout and a marketplace copy) do not flip the link every
//     session and a newer install is never downgraded;
//   - never touches a regular file, a directory, or a working symlink to
//     anything that is not an Enigma plugin bundle, so a real `enigma` install
//     further down PATH is reported, not shadowed;
//   - never throws. A hook that throws breaks the user's session.
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ShimStatus =
  /** The symlink did not exist and now does. */
  | 'installed'
  /** Already correct — Enigma is on PATH. Nothing was written. */
  | 'present'
  /** A stale shim (dead plugin root, or a strictly older plugin install) was re-pointed at the current CLI. */
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
  /** Read-only callers only: a working shim points at an older Enigma install; a session would re-point it. */
  | 'stale'
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

/**
 * A directory this user can write and that is not world-writable. A
 * world-writable directory (`/tmp`, mode 1777) is where an unrelated process
 * leaves files, not a place to put an executable a session will later run, so
 * it is never a shim location even when `accessSync` says we may write there.
 * Group-writable is allowed: the user already owns that trust boundary.
 */
function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return (statSync(dir).mode & 0o002) === 0;
  } catch {
    return false;
  }
}

interface BundleManifest {
  name: string | null;
  version: string | null;
  root: string;
}

/** The plugin manifest beside `<root>/dist/cli.mjs`, or null when `cli` is not laid out that way. */
function readBundleManifest(cli: string): BundleManifest | null {
  try {
    if (basename(cli) !== 'cli.mjs') return null;
    const dist = dirname(cli);
    if (basename(dist) !== 'dist') return null;
    const root = dirname(dist);
    const manifest: unknown = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) return null;
    const { name, version } = manifest as { name?: unknown; version?: unknown };
    return { name: typeof name === 'string' ? name : null, version: typeof version === 'string' ? version : null, root };
  } catch {
    return null;
  }
}

/** `[major, minor, patch, prerelease]`, or null when `v` is not semver-shaped. */
function parseSemver(v: string | null): [number, number, number, string] | null {
  const m = v === null ? null : /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : null;
}

/**
 * SemVer §11 precedence for two NON-EMPTY prerelease strings: identifiers are
 * compared left to right; numeric identifiers compare numerically, a numeric
 * identifier sorts before an alphanumeric one, alphanumeric identifiers compare
 * in ASCII order, and with an equal prefix the shorter list sorts first.
 * (`rc.2` < `rc.10`; `alpha` < `alpha.1` < `alpha.beta` < `beta`.)
 */
function comparePrerelease(a: string, b: string): number {
  const xs = a.split('.');
  const ys = b.split('.');
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i] as string;
    const y = ys[i] as string;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const [nx, ny] = [BigInt(x), BigInt(y)];
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return Math.sign(xs.length - ys.length);
}

/** True only when both versions parse and `a` is strictly lower than `b`. `+build` metadata is ignored. */
function isOlder(a: string | null, b: string | null): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    const [xi, yi] = [x[i] as number, y[i] as number];
    if (xi !== yi) return xi < yi;
  }
  // Same numbers: a release outranks any prerelease of it.
  if (x[3] === y[3]) return false;
  if (x[3] === '') return false;
  if (y[3] === '') return true;
  return comparePrerelease(x[3], y[3]) < 0;
}

/** What currently occupies `<dir>/enigma`. */
type Slot = 'free' | 'dangling' | 'stale' | 'ours' | 'foreign';

function classify(dest: string, cli: string): { slot: Slot; link: string | null; detail?: string } {
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

  // Compare real paths so a link that reaches the current CLI through another
  // symlink (a symlinked plugin root, macOS `/var` -> `/private/var`) is still
  // ours. Anything else that resolves is only replaceable when it is provably a
  // STRICTLY OLDER Enigma plugin bundle; a real `enigma` binary, a same-version
  // or newer Enigma install, and a bundle whose version cannot be compared are
  // never touched.
  try {
    const realLink = realpathSync(link);
    const realCli = realpathSync(cli);
    if (realLink === realCli) return { slot: 'ours', link };
    const other = readBundleManifest(realLink);
    if (other?.name === 'enigma') {
      if (isOlder(other.version, readBundleManifest(realCli)?.version ?? null)) return { slot: 'stale', link };
      return {
        slot: 'foreign',
        link,
        detail: `${dest} points at another Enigma install (${other.root}, version ${other.version ?? 'unknown'}) and was left alone`,
      };
    }
  } catch {
    // unresolvable after the F_OK probe (raced away, permission) — leave it alone
  }
  return { slot: 'foreign', link };
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
      const { slot, link, detail: slotDetail } = classify(dest, cli);

      if (slot === 'ours') return { status: 'present', target: dest, cli, link, detail: null };
      if (slot === 'foreign') {
        return { status: 'occupied', target: dest, cli, link, detail: slotDetail ?? `${dest} is not a shim and was left alone` };
      }
      if (slot === 'dangling' || slot === 'stale') {
        if (!isWritableDir(dir)) {
          // A dead link is inert, so keep looking. A stale link still RUNS, an
          // older Enigma, and would shadow any shim created further down PATH:
          // report it instead of pretending a new one would help.
          if (slot === 'dangling') continue;
          return { status: 'occupied', target: dest, cli, link, detail: `${dest} points at an older Enigma install and ${dir} cannot be safely written to` };
        }
        if (!write) {
          return slot === 'stale'
            ? { status: 'stale', target: dest, cli, link, detail: 'a working shim points at an older Enigma install; a session would re-point it' }
            : { status: 'pending', target: dest, cli, link: cli, detail: 'a dangling shim would be refreshed here' };
        }
        if (linkShim(dest, cli)) return { status: 'repointed', target: dest, cli, link: cli, detail: null };
        if (slot === 'stale') return { status: 'failed', target: dest, cli, link, detail: `could not refresh ${dest}` };
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
      return `Enigma: refreshed the "enigma" PATH shim at ${result.target} (it pointed at an older or removed plugin version).`;
    case 'occupied':
      return `Enigma: ${result.detail} — "enigma" on your PATH may not be this Enigma. Run this Enigma directly: node "${result.cli ?? ''}" run -- <command>`;
    case 'no-writable-dir':
    case 'failed':
      return `Enigma: could not put "enigma" on PATH (${result.detail}). Run commands through: node "${result.cli ?? ''}" run -- <command>`;
    case 'disabled':
    case 'present':
    case 'unavailable':
      return null;
    case 'stale':
      return `Enigma: "enigma" on PATH points at an older Enigma install (${result.link}); the next session start will re-point it to this version.`;
    case 'pending':
      return `Enigma: "enigma" is not on PATH yet; the next session start will create it at ${result.target}.`;
  }
}
