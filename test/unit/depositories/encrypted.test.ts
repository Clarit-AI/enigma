import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptedDepositoryModule } from '../../../src/storage/depositories/encrypted.js';
import { keyPath, secretsPath } from '../../../src/core/paths.js';
import { EnigmaError } from '../../../src/core/errors.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('encrypted depository', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reports available without prompting', async () => {
    await expect(encryptedDepositoryModule.detect()).resolves.toEqual({ id: 'encrypted', promptProfile: 'none', available: true });
  });

  it('first set creates a random 32-byte 0600 key file and a 0600 secrets file', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);

    const keyBuf = readFileSync(keyPath());
    expect(keyBuf).toHaveLength(32);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
  });

  it('round-trips a value through per-entry AES-256-GCM', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);

    await expect(depo.resolve('global/OPENAI_API_KEY')).resolves.toBe(SENTINEL);
    await expect(depo.has('global/OPENAI_API_KEY')).resolves.toBe(true);

    const raw = readFileSync(secretsPath(), 'utf8');
    expect(raw).not.toContain(SENTINEL);
    const parsed = JSON.parse(raw);
    expect(parsed.entries['global/OPENAI_API_KEY']).toMatchObject({ iv: expect.any(String), tag: expect.any(String), ct: expect.any(String) });
  });

  it('has() and resolve() report absence for an unknown ref', async () => {
    const depo = encryptedDepositoryModule.create({});
    await expect(depo.has('global/MISSING')).resolves.toBe(false);
    await expect(depo.resolve('global/MISSING')).rejects.toThrow(EnigmaError);
  });

  it('delete removes the entry', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);
    await depo.delete('global/OPENAI_API_KEY');

    await expect(depo.has('global/OPENAI_API_KEY')).resolves.toBe(false);
  });

  it('resolve after the key file is deleted fails fast naming "encrypted", with no value in the message (S1.2)', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);
    unlinkSync(keyPath());

    try {
      await depo.resolve('global/OPENAI_API_KEY');
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      const enigmaErr = err as EnigmaError;
      expect(enigmaErr.code).toBe('E_READ_FAILED');
      expect(enigmaErr.depository).toBe('encrypted');
      expect(enigmaErr.message).not.toContain(SENTINEL);
    }
  });
});
