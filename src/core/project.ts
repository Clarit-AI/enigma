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
 * pointer (with or without a space after the colon — git accepts both).
 * Trailing whitespace and CRLF are trimmed.
 */
export function parseGitdirPointer(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (firstLine === undefined) return null;
  const match = /^gitdir:(\s*)(.+?)\s*$/.exec(firstLine);
  if (!match) return null;
  return match[2] || null;
}

/**
 * Parses the contents of a `commondir` file. Returns the trimmed path, or
 * `null` if the file is empty or whitespace-only. A missing or unreadable
 * file is the caller's problem to detect first (with `existsSync`).
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

function safeRealpath(p: string, fallback: string): string {
  try {
    return realpathSync(p);
  } catch {
    return fallback;
  }
}

function readFirstLine(filePath: string): string | null {
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
 *     `realpath(worktreeRoot)`. Never throws.
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
      const raw = readFirstLine(gitEntryPath);
      if (raw === null) return fallback;
      const pointer = parseGitdirPointer(raw);
      if (pointer === null) return fallback;
      const gitdir = resolveGitPointer(worktreeRoot, pointer);
      if (!existsSync(gitdir)) return fallback;
      const commondirFile = join(gitdir, 'commondir');
      let resolvedCommon: string | null = null;
      if (existsSync(commondirFile)) {
        const content = readFirstLine(commondirFile);
        if (content !== null) {
          const cdp = parseCommondirPointer(content);
          if (cdp !== null) resolvedCommon = resolveGitPointer(gitdir, cdp);
        }
      }
      commonDir = resolvedCommon ?? gitdir;
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
