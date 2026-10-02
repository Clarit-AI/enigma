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

/** One `.gitignore` glob as a RegExp: `**` any depth, `*` within a segment, `?` one character. */
function gitignoreGlobToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when a `.gitignore` pattern matches `relPath` (posix, project-relative) or a directory above it. Proportionate: no negation, no nested `.gitignore` files. */
function gitignorePatternCovers(pattern: string, relPath: string): boolean {
  const glob = pattern.replace(/^\//, '').replace(/\/$/, '');
  const re = gitignoreGlobToRegExp(glob);
  const segments = relPath.split('/');
  // A pattern with a slash in it is anchored to the project root; one without matches any path segment.
  if (glob.includes('/') || pattern.startsWith('/')) return segments.some((_, i) => re.test(segments.slice(0, i + 1).join('/')));
  return segments.some((segment) => re.test(segment));
}

/**
 * Returns a warning when `<projectPath>/<targetPath>` is not covered by
 * `.gitignore` (proportionate check, not a full glob engine). The default
 * `targetPath` is `.env` and keeps the original literal-pattern check and
 * wording exactly; any other target (the renderer's `render.path`) is
 * matched against the patterns by its path, and the warning names that path.
 */
export function checkEnvGitignore(projectPath: string, targetPath: string = '.env'): string[] {
  const gitignorePath = join(projectPath, '.gitignore');
  const custom = targetPath !== '.env';
  const label = custom ? targetPath.split(/[\\/]/).join('/') : '.env';
  if (!existsSync(gitignorePath)) {
    return [`${label} is not gitignored: no .gitignore file found in this project`];
  }
  const lines = readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  const covered = lines.some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return false;
    if (custom) return gitignorePatternCovers(line, label);
    return GITIGNORE_ENV_PATTERNS.has(line.replace(/^\//, '').replace(/\/$/, ''));
  });
  return covered ? [] : [`${label} is not gitignored: add ${label} to .gitignore before committing`];
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
