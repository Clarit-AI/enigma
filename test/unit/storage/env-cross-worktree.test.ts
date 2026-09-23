// Issue #67 AC: "`env` secret written from worktree A → listed and resolvable
// from worktree B (reads `A/.env`). A deleted → read fails fast naming `env`
// (D1.4)."
//
// Worktrees A and B share an identity after this change; the env depository
// keeps the worktree-root projectPath from the original write (D1.1, the
// location-vs-identity split), so a resolve from B follows the index entry's
// stored projectPath back to A's `.env`.
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
  let main: string;
  let wt: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;

    // Realpath all tmp dirs up front because identity canonicalizes via
    // realpath (Issue #67): a /var → /private/var symlink would otherwise
    // make A and B hash differently despite sharing a .git.
    main = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-cross-main-')));
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat\n');

    wt = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-cross-wt-')));
    writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it('a secret written from worktree A is listed and resolvable from worktree B (reads A/.env)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: main,
      actor: 'cli',
    });

    // The write landed in main's .env — findProjectPath(main) = main.
    expect(existsSync(join(main, '.env'))).toBe(true);
    const content = readFileSync(join(main, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);

    // From the linked worktree B, list finds the entry via shared identity.
    const listed = listSecrets({ scope: 'project', cwd: wt });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('OPENAI_API_KEY');
    expect(listed[0]?.projectPath).toBe(main);

    // hasSecret / resolveSecret from B follow the index entry's projectPath
    // back to A/.env — not B/.env (B/.env does not exist, and shouldn't).
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt })).resolves.toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt, actor: 'cli' })).resolves.toBe(SENTINEL);
    expect(existsSync(join(wt, '.env'))).toBe(false);
  });

  it('a secret written from worktree B is listed and resolvable from worktree A (reads B/.env)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: wt,
      actor: 'cli',
    });

    // findProjectPath(wt) = wt (lexical), so the write landed in wt's .env.
    expect(existsSync(join(wt, '.env'))).toBe(true);
    expect(existsSync(join(main, '.env'))).toBe(false);

    // From A, resolve reaches the same index entry and reads B/.env.
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: main, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('after A\'s .env file is deleted, resolveSecret from B fails fast naming `env` (D1.4)', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: main,
      actor: 'cli',
    });

    // The .env value file vanishes but A's identity (the .git) is intact:
    // wt can still resolve its gitdir, so the project id matches the index
    // entry's pid and lookup succeeds. The env depository then throws
    // E_NOT_FOUND naming 'env' (D1.4).
    rmSync(join(main, '.env'), { force: true });
    expect(existsSync(join(main, '.env'))).toBe(false);

    await expect(
      resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt, actor: 'cli' }),
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
      cwd: main,
      actor: 'cli',
    });

    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('deleteSecret from B removes both the index entry and the underlying A/.env value', async () => {
    await setSecret({
      name: 'OPENAI_API_KEY',
      value: SENTINEL,
      scope: 'project',
      depository: 'env',
      cwd: main,
      actor: 'cli',
    });

    await deleteSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt, actor: 'cli' });

    // .env file may still exist with an empty managed block
    // (`removeManagedValue` rewrites it to "# enigma:begin\n\n# enigma:end"),
    // but the key is gone — both hasSecret and resolveSecret confirm.
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt })).resolves.toBe(false);
    await expect(
      resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: wt, actor: 'cli' }),
    ).rejects.toThrow(EnigmaError);
    if (existsSync(join(main, '.env'))) {
      expect(readFileSync(join(main, '.env'), 'utf8')).not.toContain(SENTINEL);
      expect(readFileSync(join(main, '.env'), 'utf8')).not.toMatch(/OPENAI_API_KEY=/);
    }
  });
});
