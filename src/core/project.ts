import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROJECT_ID_LENGTH = 16;

/**
 * The git repository root containing `cwd`, or `cwd` itself when it isn't
 * inside a git working tree (D1.1). Walks up looking for a `.git` entry
 * (directory for a normal clone, file for a worktree) rather than shelling
 * out, so this never touches a child process.
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

/** sha256 prefix of the project's absolute path (D1.1); the path itself is recorded in clear elsewhere. */
export function projectId(cwd: string): string {
  const projectPath = findProjectPath(cwd);
  return createHash('sha256').update(projectPath).digest('hex').slice(0, PROJECT_ID_LENGTH);
}
