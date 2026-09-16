import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectPath, projectId } from '../../src/core/project.js';

describe('findProjectPath / projectId', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'enigma-project-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('finds the git toplevel from a nested subdirectory', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const nested = join(tmpRoot, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(findProjectPath(nested)).toBe(tmpRoot);
  });

  it('falls back to cwd when not inside a git repo', () => {
    const nonGit = join(tmpRoot, 'not-a-repo');
    mkdirSync(nonGit, { recursive: true });

    expect(findProjectPath(nonGit)).toBe(nonGit);
  });

  it('produces a stable 16-hex-char id for the same path', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const id1 = projectId(tmpRoot);
    const id2 = projectId(tmpRoot);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different ids for different projects', () => {
    const a = join(tmpRoot, 'a');
    const b = join(tmpRoot, 'b');
    mkdirSync(join(a, '.git'), { recursive: true });
    mkdirSync(join(b, '.git'), { recursive: true });

    expect(projectId(a)).not.toBe(projectId(b));
  });
});
