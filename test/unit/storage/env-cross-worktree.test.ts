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
import { EventEmitter } from 'node:events';
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
import { basename } from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSecret,
  hasSecret,
  listSecrets,
  resolveSecret,
  setSecret,
} from '../../../src/storage/manager.js';
import { EnigmaError } from '../../../src/core/errors.js';
import { findRepoIdentityPath, projectId } from '../../../src/core/project.js';

const SENTINEL = 'sk-cross-worktree-sentinel';

/** Captures every `op` invocation the test issues, so we can assert on
 *  argv shape and on the JSON template the depository sends to stdin. */
interface FakeCall {
  args: string[];
  stdinData: string;
}
const opCalls: FakeCall[] = [];
let respondToOp: (call: FakeCall) => { stdout?: string; stderr?: string; fail?: boolean };

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    const call: FakeCall = { args, stdinData: '' };
    stdin.write = (data: string) => {
      call.stdinData += data;
      return true;
    };
    stdin.end = () => {};
    opCalls.push(call);
    const result = respondToOp(call);
    queueMicrotask(() => {
      if (result.fail) {
        callback(Object.assign(new Error('op failure'), {}), result.stdout ?? '', result.stderr ?? '');
      } else {
        callback(null, result.stdout ?? '', result.stderr ?? '');
      }
    });
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

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

    // Default: every `op item create` succeeds with an op item id. Tests
    // that need different behaviour override respondToOp before setSecret.
    opCalls.length = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'opitemid', title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  });

  it('projectId matches across the main clone and both worktrees (identity == repo)', () => {
    // All three cwds hash to the same identity: the canonical common git
    // dir's realpath, basename stripped, is /repo for each of them.
    // findRepoIdentityPath(repo) goes through the directory branch
    // (worktreeRoot/.git is a directory), wtA/wtB go through the .git-
    // file + commondir branch, and all three converge on the same path.
    expect(findRepoIdentityPath(repo)).toBe(repo);
    expect(findRepoIdentityPath(wtA)).toBe(repo);
    expect(findRepoIdentityPath(wtB)).toBe(repo);
    expect(projectId(repo)).toBe(projectId(wtA));
    expect(projectId(repo)).toBe(projectId(wtB));
    expect(projectId(wtA)).toBe(projectId(wtB));
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

  describe('AC8 — location-side behaviour: env gitignore + 1Password title use wtA, not the identity (repo)', () => {
    it('checkEnvGitignore warns about wtA/.gitignore, not repo/.gitignore, even when both share an identity', async () => {
      // The repo carries a gitignore that covers .env — so anything that
      // reads checkEnvGitignore(repo) would see "covered, no warning".
      writeFileSync(join(repo, '.gitignore'), '.env\n');

      // setSecret from wtA, env depository, runs checkEnvGitignore(wtA) and
      // therefore warns: wtA has no .gitignore, regardless of the repo's.
      const result = await setSecret({
        name: 'OPENAI_API_KEY',
        value: SENTINEL,
        scope: 'project',
        depository: 'env',
        cwd: wtA,
        actor: 'cli',
      });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.join('\n')).toMatch(/gitignore/i);

      // Add wtA/.gitignore covering .env — the next setSecret from wtA
      // emits no warning, proving the check targeted wtA specifically.
      writeFileSync(join(wtA, '.gitignore'), '.env\n');
      const result2 = await setSecret({
        name: 'OPENAI_API_KEY',
        value: SENTINEL,
        scope: 'project',
        depository: 'env',
        cwd: wtA,
        rotate: true,
        actor: 'cli',
      });
      expect(result2.warnings).toEqual([]);
    });

    it('1Password title uses basename(wtA), not basename(repo) — title builder sees the location, not the identity', async () => {
      // Identity is repo for both worktrees; the depository context's
      // projectPath is the lexical worktree root, so the title folder is
      // the worktree's basename. The op CLI is mocked — no real call.
      await setSecret({
        name: 'OPENAI_API_KEY',
        value: SENTINEL,
        scope: 'project',
        depository: '1password',
        cwd: wtA,
        actor: 'cli',
      });

      const itemCreateCall = opCalls.find((c) => c.args[0] === 'item' && c.args[1] === 'create');
      expect(itemCreateCall).toBeDefined();
      const template = JSON.parse(itemCreateCall!.stdinData) as { title: string };
      expect(template.title).toBe(`OPENAI_API_KEY · ${basename(wtA)}`);
      expect(template.title).not.toBe(`OPENAI_API_KEY · ${basename(repo)}`);
    });
  });
});
