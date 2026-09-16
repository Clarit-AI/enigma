import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMove } from '../../../../src/cli/commands/move.js';
import { UsageError } from '../../../../src/cli/args.js';
import { hasSecret, listSecrets, resolveSecret, setSecret } from '../../../../src/storage/manager.js';
import { encryptedDepositoryModule } from '../../../../src/storage/depositories/encrypted.js';
import { auditLogPath, secretsPath } from '../../../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('cmdMove', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    // Resolved so it matches process.cwd() after chdir on platforms where tmpdir() is a symlink (e.g. macOS).
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
  });

  it('relocates a project secret from encrypted to env, preserving the value', async () => {
    await setSecret({ name: 'DB_PASSWORD', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const code = await cmdMove(['DB_PASSWORD', '--to', 'env', '--scope', 'project']);

    expect(code).toBe(0);
    const [entry] = listSecrets({ scope: 'project', cwd: tmpProject });
    expect(entry?.depository).toBe('env');
    await expect(resolveSecret('DB_PASSWORD', { scope: 'project', cwd: tmpProject, actor: 'cli' })).resolves.toBe(SENTINEL);

    const envContent = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(envContent).toContain(`DB_PASSWORD=${SENTINEL}`);
  });

  it('deletes the value from the old depository after a successful move', async () => {
    await setSecret({ name: 'DB_PASSWORD', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    const [before] = listSecrets({ scope: 'project', cwd: tmpProject });
    const oldRef = before!.ref;

    await cmdMove(['DB_PASSWORD', '--to', 'env', '--scope', 'project']);

    const stillInEncrypted = await encryptedDepositoryModule.create({}).has(oldRef);
    expect(stillInEncrypted).toBe(false);
  });

  it('leaves the original secret intact when the target depository/scope combination is invalid', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    // env does not support global scope, so this move must fail with E_SCOPE_INVALID
    // and must leave the original secret intact (no partial move).
    await expect(cmdMove(['OPENAI_API_KEY', '--to', 'env', '--scope', 'global'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_SCOPE_INVALID' }),
    );
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('is a no-op when already in the target depository', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    const code = await cmdMove(['OPENAI_API_KEY', '--to', 'encrypted', '--scope', 'global']);

    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls[0]?.[0]).toContain('already in encrypted');
  });

  it('audits a move op on success, naming the new depository', async () => {
    await setSecret({ name: 'DB_PASSWORD', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await cmdMove(['DB_PASSWORD', '--to', 'env', '--scope', 'project']);

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l) as { op: string; ok: boolean; depository: string; actor: string });
    const moveEvent = events.find((e) => e.op === 'move');
    expect(moveEvent).toMatchObject({ op: 'move', ok: true, depository: 'env', actor: 'cli' });
  });

  it('audits a failed move op when the write to the new depository fails', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(cmdMove(['OPENAI_API_KEY', '--to', 'env', '--scope', 'global'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_SCOPE_INVALID' }),
    );

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l) as { op: string; ok: boolean });
    const moveEvent = events.find((e) => e.op === 'move');
    expect(moveEvent).toMatchObject({ op: 'move', ok: false });
  });

  it('audits a failed move op when the resolve-old step fails, not only the internal read event', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    // Corrupt the ciphertext for this ref (by name, not by grabbing the first
    // JSON key: secrets.enc can already carry entries from an unrelated
    // secret) so the resolve-old read fails with E_READ_FAILED, before the
    // move ever reaches the write-to-new-depository step.
    const ref = 'global/OPENAI_API_KEY';
    const file = JSON.parse(readFileSync(secretsPath(), 'utf8')) as { entries: Record<string, { ct: string }> };
    file.entries[ref]!.ct = Buffer.from('not-the-real-ciphertext').toString('base64');
    writeFileSync(secretsPath(), JSON.stringify(file));

    await expect(cmdMove(['OPENAI_API_KEY', '--to', 'env', '--scope', 'global'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_READ_FAILED' }),
    );

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l) as { op: string; ok: boolean });
    const readEvent = events.find((e) => e.op === 'read');
    const moveEvent = events.find((e) => e.op === 'move');
    expect(readEvent).toMatchObject({ op: 'read', ok: false });
    expect(moveEvent).toMatchObject({ op: 'move', ok: false });
  });

  it('warns naming the depository and ref, never the value, when the best-effort delete of the old copy fails', async () => {
    await setSecret({ name: 'DB_PASSWORD', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    const [before] = listSecrets({ scope: 'project', cwd: tmpProject });
    const oldRef = before!.ref;

    const deleteSpy = vi
      .spyOn(encryptedDepositoryModule, 'create')
      .mockReturnValue({
        id: 'encrypted',
        promptProfile: 'none',
        set: async (ref: string) => ref,
        resolve: async () => SENTINEL,
        delete: async () => {
          throw new Error('boom');
        },
        has: async () => true,
      });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await cmdMove(['DB_PASSWORD', '--to', 'env', '--scope', 'project']);

    expect(code).toBe(0);
    const warning = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warning).toContain('encrypted');
    expect(warning).toContain(oldRef);
    expect(warning).not.toContain(SENTINEL);

    deleteSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('throws E_NOT_FOUND for a name that was never set', async () => {
    await expect(cmdMove(['NEVER_SET', '--to', 'env', '--scope', 'project'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
  });

  it('requires both NAME and --to', async () => {
    await expect(cmdMove(['OPENAI_API_KEY'])).rejects.toThrow(UsageError);
  });
});
