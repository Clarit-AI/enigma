import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

  it('first set creates a random 32-byte base64-encoded 0600 key file and a 0600 secrets file', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);

    const keyText = readFileSync(keyPath(), 'utf8');
    expect(Buffer.from(keyText, 'base64')).toHaveLength(32);
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

  it('set resolves to the input ref unchanged', async () => {
    const depo = encryptedDepositoryModule.create({});
    await expect(depo.set('global/OPENAI_API_KEY', SENTINEL)).resolves.toBe('global/OPENAI_API_KEY');
  });

  it('two writes produce different IVs and 16-byte auth tags (A2)', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/FIRST', SENTINEL);
    await depo.set('global/SECOND', SENTINEL);

    const parsed = JSON.parse(readFileSync(secretsPath(), 'utf8'));
    const first = parsed.entries['global/FIRST'];
    const second = parsed.entries['global/SECOND'];
    expect(first.iv).not.toBe(second.iv);
    expect(Buffer.from(first.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(second.tag, 'base64')).toHaveLength(16);
  });

  it('tampered ciphertext fails auth-tag verification with E_READ_FAILED (A2)', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);

    const parsed = JSON.parse(readFileSync(secretsPath(), 'utf8'));
    const entry = parsed.entries['global/OPENAI_API_KEY'];
    const tampered = Buffer.from(entry.ct, 'base64');
    tampered[0] = tampered[0]! ^ 0xff;
    entry.ct = tampered.toString('base64');
    writeFileSync(secretsPath(), JSON.stringify(parsed));

    try {
      await depo.resolve('global/OPENAI_API_KEY');
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_READ_FAILED');
      expect((err as EnigmaError).depository).toBe('encrypted');
    }
  });

  it('resolve with a key file that is not exactly 32 bytes decoded fails with E_READ_FAILED naming "encrypted" (B4)', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);
    writeFileSync(keyPath(), Buffer.from('too-short').toString('base64'));

    try {
      await depo.resolve('global/OPENAI_API_KEY');
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_READ_FAILED');
      expect((err as EnigmaError).depository).toBe('encrypted');
    }
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

  it('a corrupt secrets.enc throws EnigmaError E_VAULT_CORRUPT naming "encrypted", never a raw SyntaxError (Issue #18)', async () => {
    const depo = encryptedDepositoryModule.create({});
    await depo.set('global/OPENAI_API_KEY', SENTINEL);
    const CORRUPT_MARKER = 'totally-broken-bytes-should-never-appear-in-the-message';
    writeFileSync(secretsPath(), `{ ${CORRUPT_MARKER}`);

    try {
      await depo.resolve('global/OPENAI_API_KEY');
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      const enigmaErr = err as EnigmaError;
      expect(enigmaErr.code).toBe('E_VAULT_CORRUPT');
      expect(enigmaErr.depository).toBe('encrypted');
      expect(enigmaErr.message).toContain(secretsPath());
      expect(enigmaErr.message).not.toContain(CORRUPT_MARKER);
    }
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
