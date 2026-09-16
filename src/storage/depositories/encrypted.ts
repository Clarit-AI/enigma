import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { EnigmaError } from '../../core/errors.js';
import { keyPath, secretsPath } from '../../core/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../../core/secure-file.js';
import type { Depository, DepositoryModule } from '../interfaces.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FILE_MODE = 0o600;

interface EncryptedEntry {
  iv: string;
  tag: string;
  ct: string;
}

interface SecretsFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

const EMPTY_SECRETS_FILE: SecretsFile = { version: 1, entries: {} };

function readKey(): Buffer | undefined {
  if (!existsSync(keyPath())) return undefined;
  const key = Buffer.from(readFileSync(keyPath(), 'utf8'), 'base64');
  if (key.length !== KEY_BYTES) readFailed();
  return key;
}

function getOrCreateKey(): Buffer {
  const existing = readKey();
  if (existing) return existing;
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath(), key.toString('base64'), { mode: FILE_MODE });
  return key;
}

function readSecretsFile(): SecretsFile {
  return readJsonFile(secretsPath(), EMPTY_SECRETS_FILE);
}

function writeSecretsFile(file: SecretsFile): void {
  writeJsonFileAtomic(secretsPath(), file);
}

function encryptValue(value: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function decryptEntry(entry: EncryptedEntry, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

function readFailed(): never {
  throw new EnigmaError({
    code: 'E_READ_FAILED',
    message: 'failed to read secret from encrypted depository',
    depository: 'encrypted',
  });
}

function createEncryptedDepository(): Depository {
  return {
    id: 'encrypted',
    promptProfile: 'none',

    async set(ref, value) {
      const key = getOrCreateKey();
      const file = readSecretsFile();
      file.entries[ref] = encryptValue(value, key);
      writeSecretsFile(file);
      return ref;
    },

    async resolve(ref) {
      const key = readKey();
      if (!key) readFailed();
      const file = readSecretsFile();
      const entry = file.entries[ref];
      if (!entry) throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'encrypted' });
      try {
        return decryptEntry(entry, key);
      } catch {
        return readFailed();
      }
    },

    async delete(ref) {
      const file = readSecretsFile();
      if (ref in file.entries) {
        delete file.entries[ref];
        writeSecretsFile(file);
      }
    },

    async has(ref) {
      return ref in readSecretsFile().entries;
    },
  };
}

export const encryptedDepositoryModule: DepositoryModule = {
  id: 'encrypted',
  promptProfile: 'none',
  async detect() {
    return { id: 'encrypted', promptProfile: 'none', available: true };
  },
  create: createEncryptedDepository,
};
