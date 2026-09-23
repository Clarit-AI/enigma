import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as nodePath from 'node:path';
import type { PlatformPath } from 'node:path';

const PROJECT_ID_LENGTH = 16;

/**
 * Lexical: the worktree root (D1.1). Walks up looking for a `.git` entry
 * (directory for a normal clone, file for a linked worktree) and returns
 * the first directory that holds one, or `cwd` itself when not in a git
 * working tree. Pure fs, never spawns a child process. Used for the `.env`
 * depository location, the gitignore check, and the 1Password item title —
 * all of which want the worktree root, not the repository identity (D1.1).
 */
export function findProjectPath(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

const platformPath: PlatformPath = nodePath;

/**
 * Parses the contents of a `.git` pointer file. Returns the trimmed
 * gitdir path, or `null` if the file's first line isn't a `gitdir:`
 * pointer (with or without a space after the colon — git accepts both),
 * or if the value is missing or whitespace-only. Trailing whitespace and
 * CRLF are trimmed.
 */
export function parseGitdirPointer(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (firstLine === undefined) return null;
  // (\S.*?)? — the value must start with a non-whitespace character, and
  // the group is optional. "gitdir:" alone, or "gitdir:   ", would otherwise
  // match (.+?) as a single space character and produce a whitespace-only
  // pointer that breaks downstream resolution.
  const match = /^gitdir:(\s*)(\S.*?)?\s*$/.exec(firstLine);
  if (!match) return null;
  return match[2] ?? null;
}

/**
 * Parses the contents of a `commondir` file. Returns the trimmed path, or
 * `null` if the file is empty or whitespace-only. A missing or unreadable
 * file is the caller's problem to detect first (with `pathStat`).
 */
export function parseCommondirPointer(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (firstLine === undefined) return null;
  const trimmed = firstLine.trim();
  return trimmed || null;
}

/**
 * Pure resolver: trims `rawContent` and resolves it against `baseDir`,
 * leaving an already-absolute pointer untouched. Exported for unit tests
 * that exercise both `path.posix` and `path.win32` (a `C:/...` Windows-style
 * pointer is platform-specific: on macOS the platform `path.resolve`
 * treats it as a relative segment, so the Windows AC can only be evidenced
 * through `path.win32`).
 */
export function resolveGitPointer(baseDir: string, rawContent: string, pathImpl: PlatformPath = platformPath): string {
  const trimmed = rawContent.trim();
  return pathImpl.isAbsolute(trimmed) ? trimmed : pathImpl.resolve(baseDir, trimmed);
}

function gitEntryKind(entryPath: string): 'directory' | 'file' | 'missing' {
  try {
    const st = statSync(entryPath);
    if (st.isDirectory()) return 'directory';
    if (st.isFile()) return 'file';
    return 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * Three-valued stat: distinguishes "path is genuinely absent" (ENOENT or
 * ENOTDIR, treated as "doesn't exist — caller may fall through to its
 * absent-path branch") from "stat failed for some other reason" (EACCES,
 * EPERM, …, treated as "caller must fall back because we cannot tell").
 * `existsSync` collapses both into `false`, which silently misclassifies
 * a non-traversable directory as an absent one — the exact bug a chmod
 * 000 on `<gitdir>` was triggering for `commondir` lookups.
 */
function statErrorKind(err: unknown): 'absent' | 'error' {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'error';
}

function pathStat(p: string): 'exists' | 'absent' | 'error' {
  try {
    statSync(p);
    return 'exists';
  } catch (err) {
    return statErrorKind(err);
  }
}

/**
 * Like `pathStat`, but additionally requires `p` to be a directory
 * (`statSync` follows symlinks, so a symlink to a real directory still
 * counts). A `gitdir:` or `commondir` pointer can resolve to any path on
 * disk, including an existing regular file; treating "exists" alone as
 * good enough would let that file's own realpath become the project
 * identity. A non-directory is folded into `'error'` (not a new variant)
 * because callers already treat "error" as "cannot use this as a
 * gitdir/common-dir, fall back" — the same action a wrong type requires.
 */
function directoryStat(p: string): 'directory' | 'absent' | 'error' {
  try {
    return statSync(p).isDirectory() ? 'directory' : 'error';
  } catch (err) {
    return statErrorKind(err);
  }
}

function safeRealpath(p: string, fallback: string): string {
  try {
    return realpathSync(p);
  } catch {
    return fallback;
  }
}

/** Returns the file's UTF-8 contents, or `null` on any read failure. */
function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Canonical: the repository's common git dir, used to compute the project
 * identity (D1.1). One rule, pure fs, no child process:
 *  1. Walk up from `cwd` to the first `.git` entry (same as `findProjectPath`).
 *  2. Common dir:
 *     - `.git` is a directory → that directory.
 *     - `.git` is a file containing `gitdir: <p>` → gitdir = `<p>` resolved
 *       against the `.git` file's own directory. If `<gitdir>/commondir`
 *       exists, common dir = its contents resolved against gitdir. Otherwise
 *       common dir = gitdir.
 *  3. Identity path = the parent of `realpath(commonDir)` if its basename is
 *     `.git`, otherwise `realpath(commonDir)` itself (e.g. a bare `repo.git`).
 *  4. If any read, parse, or realpath step fails → fall back to
 *     `realpath(worktreeRoot)`. In particular, a `<gitdir>/commondir` that
 *     is present but empty / whitespace-only / unreadable is treated as a
 *     failure (NOT a "use gitdir" success): git itself never writes an
 *     empty commondir, so its presence in that state means something is
 *     wrong with the worktree, not that commondir is intentionally absent.
 *     Stat errors are inspected for `err.code`: only `ENOENT`/`ENOTDIR`
 *     count as "file is absent, use gitdir"; EACCES/EPERM/etc. fall back
 *     to `realpath(worktreeRoot)` rather than silently misclassify a
 *     non-traversable gitdir as "no commondir here". The resolved gitdir
 *     and, when present, the resolved commondir target must each be a
 *     directory (symlinks to a real directory count) — a `gitdir:` or
 *     `commondir` pointer that resolves to an existing regular file falls
 *     back too, rather than hashing that file's own realpath. Never throws.
 */
export function findRepoIdentityPath(cwd: string): string {
  const worktreeRoot = findProjectPath(cwd);
  const fallback = safeRealpath(worktreeRoot, worktreeRoot);

  try {
    const gitEntryPath = `${worktreeRoot}/.git`;
    const kind = gitEntryKind(gitEntryPath);

    let commonDir: string;
    if (kind === 'directory') {
      commonDir = gitEntryPath;
    } else if (kind === 'file') {
      const raw = readFileSafe(gitEntryPath);
      if (raw === null) return fallback;
      const pointer = parseGitdirPointer(raw);
      if (pointer === null) return fallback;
      const gitdir = resolveGitPointer(worktreeRoot, pointer);
      if (directoryStat(gitdir) !== 'directory') return fallback;

      const commondirFile = join(gitdir, 'commondir');
      const commondirState = pathStat(commondirFile);
      if (commondirState === 'exists') {
        // Present: must be readable AND parse to a non-empty pointer, or
        // we fall back. Distinguishes from "absent" (common dir = gitdir).
        const content = readFileSafe(commondirFile);
        if (content === null) return fallback;
        const cdp = parseCommondirPointer(content);
        if (cdp === null) return fallback;
        const commondirTarget = resolveGitPointer(gitdir, cdp);
        if (directoryStat(commondirTarget) !== 'directory') return fallback;
        commonDir = commondirTarget;
      } else if (commondirState === 'absent') {
        commonDir = gitdir;
      } else {
        // EACCES / EPERM / … — we can't tell whether commondir is absent
        // or merely unreadable (e.g. gitdir itself is chmod 000). Falling
        // back to realpath(worktreeRoot) per the issue's step 4 is the
        // safe choice: it never silently hashes a per-worktree gitdir.
        return fallback;
      }
    } else {
      return fallback;
    }

    const resolved = safeRealpath(commonDir, fallback);
    return basename(resolved) === '.git' ? dirname(resolved) : resolved;
  } catch {
    return fallback;
  }
}

/** sha256 prefix of the project's identity path (D1.1); the path itself is recorded in clear elsewhere. */
export function projectId(cwd: string): string {
  const identityPath = findRepoIdentityPath(cwd);
  return createHash('sha256').update(identityPath).digest('hex').slice(0, PROJECT_ID_LENGTH);
}
