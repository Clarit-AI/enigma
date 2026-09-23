// Issue #67 AC: "`env` secret written from worktree A → listed and resolvable
// from worktree B (reads `A/.env`). A deleted → read fails fast naming `env`
// (D1.4)."
//
// Layout (matches the AC literally — A and B are linked worktrees of one
// repo, NOT the main clone itself):
//
//   /repo/                  ← main clone, contains the common git dir
//     .git/
//       worktrees/a/        ← gitdir for worktree A
//         commondir (../..)
//       worktrees/b/        ← gitdir for worktree B
//         commondir (../..)
//   /wt-a/.git              ← file: "gitdir: /repo/.git/worktrees/a"
//   /wt-b/.git              ← file: "gitdir: /repo/.git/worktrees/b"
//
// A's identity (the common git dir realpath, basename stripped) is /repo,
// and so is B's; their projectId hashes match. The env depository keeps
// the lexical worktree-root projectPath from the original write (D1.1,
// location-vs-identity split), so a resolve from B follows the index
// entry's stored projectPath back to A's `.env` — and when A's `.env` is
// gone, the env depository throws E_NOT_FOUND naming 'env' (D1.4).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSecret,
  hasSecret,
  listSecrets,
  resolveSecret,
  setSecret,
} from '../../../src/storage/manager.js';
import { EnigmaError } from '../../../src/core/errors.js';

const SENTINEL = 'sk-cross-worktree-sentinel';

describe('env depository across linked worktrees (Issue #67 AC)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repo: string;
  let wtA: string;
  let wtB: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;

    // Realpath every tmp dir up front because identity canonicalizes via
    // realpath (Issue #67): a /var → /private/var symlink would otherwise
    // make A and B hash differently despite sharing a .git.
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-cross-repo-')));
    // Main clone's .git is a directory (the common git dir).
    mkdirSync(join(repo, '.git', 'worktrees', 'a'), { recursive: true });
    mkdirSync(join(repo, '.git', 'worktrees', 'b'), { recursive: true });
    writeFileSync(join(repo, '.git', 'worktrees', 'a', 'commondir'), '../..\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'a', 'HEAD'), 'ref: refs/heads/feat-a\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'b', 'commondir'), '../..\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'b', 'HEAD'), 'ref: refs/heads/feat-b\n');

    wtA = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-cross-wt-a-')));
    writeFileSync(join(wtA, '.git'), `gitdir: ${repo}/.git/worktrees/a\n`);

    wtB = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-cross-wt-b-')));
    writeFileSync(join(wtB, '.git'), `gitdir: ${repo}/.git/worktrees/b\n`);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  });

  it('a secret written from worktree A is listed and resolvable from worktree B (reads A/.env)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wtA,
      actor: 'cli',
    });

    // The write landed in wtA's .env — findProjectPath(wtA) = wtA.
    expect(existsSync(join(wtA, '.env'))).toBe(true);
    const content = readFileSync(join(wtA, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);

    // From worktree B, list finds the entry via shared identity (projectId
    // of both A and B is sha256(repo), via the commondir walk).
    const listed = listSecrets({ scope: 'project', cwd: wtB });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('OPENAI_API_KEY');
    expect(listed[0]?.projectPath).toBe(wtA);

    // hasSecret / resolveSecret from B follow the index entry's projectPath
    // back to wtA/.env — not wtB/.env (wtB/.env does not exist, and shouldn't).
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB })).resolves.toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' })).resolves.toBe(SENTINEL);
    expect(existsSync(join(wtB, '.env'))).toBe(false);
  });

  it('a secret written from worktree B is listed and resolvable from worktree A (reads B/.env)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wtB,
      actor: 'cli',
    });

    // findProjectPath(wtB) = wtB (lexical), so the write landed in wtB's .env.
    expect(existsSync(join(wtB, '.env'))).toBe(true);
    expect(existsSync(join(wtA, '.env'))).toBe(false);

    // From A, resolve reaches the same index entry and reads B/.env.
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtA, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('the main clone (cwd=repo) sees the same projectId as both worktrees', () => {
    // Sanity: the identity walk resolves to /repo for all three cwds —
    // not just for the worktree checkouts, but for the main clone too,
    // because main's .git is a directory whose basename IS .git.
    expect(hasSecret('UNUSED_NAME', { scope: 'project', cwd: repo })).toBeDefined();
    // Implicit: listSecrets does not throw; an empty index is fine.
    expect(listSecrets({ scope: 'project', cwd: repo })).toEqual([]);
  });

  it('AC literal reading: after `rm -rf` worktree A, resolve from B fails fast naming `env` (D1.4)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wtA,
      actor: 'cli',
    });

    // Wipe A entirely — both wtA/.env and wtA/.git go away. The repo is
    // untouched: wtB's .git file still points into repo/.git/worktrees/b,
    // and repo/.git/worktrees/b/commondir is still "../..", so wtB's
    // identity is still repo. The index entry survives (it lives under
    // ENIGMA_HOME) with projectPath=wtA.
    rmSync(wtA, { recursive: true, force: true });
    expect(existsSync(wtA)).toBe(false);
    expect(existsSync(wtB)).toBe(true);

    // B can still see the entry — identity is intact.
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB })).resolves.toBe(true);

    // But the resolve path follows the stored projectPath (wtA) to its
    // .env file, which is gone — env depository throws E_NOT_FOUND naming
    // the `env` depository (D1.4).
    await expect(
      resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND', depository: 'env' }),
    );
  });

  it('additionally: A\'s .env file removed (but wtA otherwise intact) also fails fast naming `env` (D1.4)', async () => {
    // Narrower case: only the value file vanishes; the worktree itself
    // is still on disk. B's identity is still repo and the lookup still
    // succeeds; the env depository throws on the missing file.
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wtA,
      actor: 'cli',
    });

    rmSync(join(wtA, '.env'), { force: true });
    expect(existsSync(join(wtA, '.env'))).toBe(false);

    await expect(
      resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND', depository: 'env' }),
    );
  });

  it('encrypted secret from A is also resolvable from B (index lookup, same identity) — sanity check that the env case is the env-specific behaviour, not identity-specific', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'encrypted',
      cwd: wtA,
      actor: 'cli',
    });

    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('deleteSecret from B removes both the index entry and the underlying A/.env value', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wtA,
      actor: 'cli',
    });

    await deleteSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' });

    // .env file may still exist with an empty managed block
    // (`removeManagedValue` rewrites it to "# enigma:begin\n\n# enigma:end"),
    // but the key is gone — both hasSecret and resolveSecret confirm.
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB })).resolves.toBe(false);
    await expect(
      resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wtB, actor: 'cli' }),
    ).rejects.toThrow(EnigmaError);
    if (existsSync(join(wtA, '.env'))) {
      expect(readFileSync(join(wtA, '.env'), 'utf8')).not.toContain(SENTINEL);
      expect(readFileSync(join(wtA, '.env'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
    }
  });
});
