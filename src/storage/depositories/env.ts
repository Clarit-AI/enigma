import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryContext, DepositoryModule } from '../interfaces.js';

const BEGIN_MARKER = '# enigma:begin';
const END_MARKER = '# enigma:end';
const FILE_MODE = 0o600;
const GITIGNORE_ENV_PATTERNS = new Set(['.env', '.env*', '*.env', '**/.env', '.env**']);
const NEEDS_QUOTING = /[\s#"'\\$]/;

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** Dotenv-compatible encoding: bare when safe, else double-quoted with `\`, `"`, CR, and LF escaped. */
function encodeValue(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Exact inverse of encodeValue: unwraps a double-quoted value and unescapes `\\`, `\"`, `\r`, `\n`. */
function decodeValue(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\\\|\\"|\\r|\\n/g, (escape) => {
    switch (escape) {
      case '\\\\':
        return '\\';
      case '\\"':
        return '"';
      case '\\r':
        return '\r';
      default:
        return '\n';
    }
  });
}

function findBlock(lines: string[]): { beginIdx: number; endIdx: number } | undefined {
  const beginIdx = lines.findIndex((l) => l === BEGIN_MARKER);
  if (beginIdx === -1) return undefined;
  const endIdx = lines.findIndex((l, i) => l === END_MARKER && i > beginIdx);
  if (endIdx === -1) return undefined;
  return { beginIdx, endIdx };
}

/**
 * Writes/updates `name` inside the managed block, preserving every other line
 * byte-for-byte and the file's own line-ending style. Appends the block at
 * EOF — behind a single newline if the file doesn't already end with one —
 * when no block exists yet.
 */
function upsertManagedBlock(content: string, name: string, value: string): string {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);

  const encoded = encodeValue(value);
  if (block) {
    const blockLines = lines.slice(block.beginIdx + 1, block.endIdx);
    const existingIdx = blockLines.findIndex((l) => l.startsWith(`${name}=`));
    if (existingIdx !== -1) {
      blockLines[existingIdx] = `${name}=${encoded}`;
    } else {
      blockLines.push(`${name}=${encoded}`);
    }
    const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
    return newLines.join(eol);
  }

  const needsNewline = content.length > 0 && !content.endsWith(eol);
  const prefix = needsNewline ? content + eol : content;
  return `${prefix}${BEGIN_MARKER}${eol}${name}=${encoded}${eol}${END_MARKER}${eol}`;
}

function extractManagedValue(content: string, name: string): string | undefined {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);
  if (!block) return undefined;
  const match = lines.slice(block.beginIdx + 1, block.endIdx).find((l) => l.startsWith(`${name}=`));
  return match ? decodeValue(match.slice(name.length + 1)) : undefined;
}

function removeManagedValue(content: string, name: string): string {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);
  if (!block) return content;
  const blockLines = lines.slice(block.beginIdx + 1, block.endIdx).filter((l) => !l.startsWith(`${name}=`));
  const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
  return newLines.join(eol);
}

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
      writeFileSync(envFilePath, upsertManagedBlock(readEnvFile(), ref, value), { mode: FILE_MODE });
      return ref;
    },

    async resolve(ref) {
      const value = extractManagedValue(readEnvFile(), ref);
      if (value === undefined) {
        throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'env' });
      }
      return value;
    },

    async delete(ref) {
      const content = readEnvFile();
      if (content) writeFileSync(envFilePath, removeManagedValue(content, ref), { mode: FILE_MODE });
    },

    async has(ref) {
      return extractManagedValue(readEnvFile(), ref) !== undefined;
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
