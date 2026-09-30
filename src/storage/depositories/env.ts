import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryContext, DepositoryModule } from '../interfaces.js';
import {
  extractManagedValue,
  removeManagedValue,
  upsertManagedBlock,
  ENV_BEGIN_MARKER,
  ENV_END_MARKER,
} from '../dotenv-file.js';

/* ------------------------------------------------------------------ *
 *  Env depository (Issue #13, D4.3)                                    *
 * ------------------------------------------------------------------ *
 *
 * The env depository's `# enigma:begin` / `# enigma:end` block is
 * written with the same shape the renderer uses for its own block — both
 * blocks share the EOL detector, the encoder, and the begin/end block
 * writer, now defined in `src/storage/dotenv-file.ts` so the renderer can
 * reuse them with its own marker pair. The depository's file format and
 * observable behaviour are unchanged; the shared helpers produce byte-
 * identical output for the inputs this depository feeds them.
 */

const FILE_MODE = 0o600;
const ENV_BLOCK_MARKERS = { begin: ENV_BEGIN_MARKER, end: ENV_END_MARKER } as const;
const GITIGNORE_ENV_PATTERNS = new Set(['.env', '.env*', '*.env', '**/.env', '.env**']);

/** Returns a warning when `<projectPath>/.env` is not covered by `.gitignore` (proportionate literal-pattern check, not a full glob engine). */
export function checkEnvGitignore(projectPath: string): string[] {
  const gitignorePath = join(projectPath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return ['.env is not gitignored: no .gitignore file found in this project'];
  }
  const lines = readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  const covered = lines.some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return false;
    const normalized = line.replace(/^\//, '').replace(/\/$/, '');
    return GITIGNORE_ENV_PATTERNS.has(normalized);
  });
  return covered ? [] : ['.env is not gitignored: add .env to .gitignore before committing'];
}

function requireProjectPath(ctx: DepositoryContext): string {
  if (!ctx.projectPath) {
    throw new EnigmaError({
      code: 'E_DEPOSITORY_UNAVAILABLE',
      message: 'env depository requires a project path',
      depository: 'env',
    });
  }
  return ctx.projectPath;
}

function createEnvDepository(ctx: DepositoryContext): Depository {
  const envFilePath = join(requireProjectPath(ctx), '.env');
  const readEnvFile = () => (existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '');

  return {
    id: 'env',
    promptProfile: 'none',

    // ref is the bare NAME for env — the file itself is located via DepositoryContext.projectPath.
    async set(ref, value) {
      writeFileSync(envFilePath, upsertManagedBlock(readEnvFile(), ref, value, ENV_BLOCK_MARKERS), { mode: FILE_MODE });
      return ref;
    },

    async resolve(ref) {
      const value = extractManagedValue(readEnvFile(), ref, ENV_BLOCK_MARKERS);
      if (value === undefined) {
        throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'env' });
      }
      return value;
    },

    async delete(ref) {
      const content = readEnvFile();
      if (content) writeFileSync(envFilePath, removeManagedValue(content, ref, ENV_BLOCK_MARKERS), { mode: FILE_MODE });
    },

    // Issue #70: compare-and-delete in one synchronous read-modify-write, so
    // a `.env` line repopulated since the displaced copy was captured is
    // never removed.
    async deleteIfUnchanged(ref, expectedValue) {
      const content = readEnvFile();
      if (extractManagedValue(content, ref, ENV_BLOCK_MARKERS) !== expectedValue) return false;
      writeFileSync(envFilePath, removeManagedValue(content, ref, ENV_BLOCK_MARKERS), { mode: FILE_MODE });
      return true;
    },

    async has(ref) {
      return extractManagedValue(readEnvFile(), ref, ENV_BLOCK_MARKERS) !== undefined;
    },
  };
}

export const envDepositoryModule: DepositoryModule = {
  id: 'env',
  promptProfile: 'none',
  async detect() {
    return { id: 'env', promptProfile: 'none', available: true };
  },
  create: createEnvDepository,
};