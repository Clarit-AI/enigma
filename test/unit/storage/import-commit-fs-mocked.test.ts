// ESM module namespaces aren't spy-able in place (vitest: "Cannot redefine
// property"), so the fs interception this file needs — controlling exactly
// what a SPECIFIC read/rename call returns/throws — has to be a hoisted
// vi.mock, not a runtime vi.spyOn. Kept separate from import-commit.test.ts
// so the bulk of ordinary tests there stay simple and unaffected by this.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedDotEnvEntry } from '../../../src/storage/dotenv-file.js';

let readFileOverride: ((path: unknown) => string | undefined) | undefined;
/**
 * `setSecret` itself writes index.json (and, for 'encrypted', secrets.enc)
 * through the SAME temp-file-plus-rename pattern this test is probing on
 * the .env rewrite — so throwing on every renameSync/unlinkSync/writeFileSync
 * call also breaks the depository write before it ever reaches the .env
 * rewrite. Scoped to the exact target path (or, for the temp file itself,
 * its known prefix) under test.
 */
let renameShouldThrowForTarget: string | undefined;
let unlinkShouldThrow = false;
/** Set to the .env path being tested: matches only ITS OWN `<path>.<hex>.tmp` write, never index.json/secrets.enc's own temp files. */
let writeShouldThrowForEnvPath: string | undefined;
const renameCalls: Array<[unknown, unknown]> = [];
const unlinkCalls: unknown[] = [];
const writeCalls: unknown[] = [];

function isOwnTempFile(path: unknown, envPath: string): boolean {
  return typeof path === 'string' && path.startsWith(`${envPath}.`) && path.endsWith('.tmp');
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: unknown, opts: unknown) => {
      const override = readFileOverride?.(path);
      if (override !== undefined) return override;
      return actual.readFileSync(path as never, opts as never);
    },
    writeFileSync: (path: unknown, data: unknown, opts: unknown) => {
      writeCalls.push(path);
      if (writeShouldThrowForEnvPath !== undefined && isOwnTempFile(path, writeShouldThrowForEnvPath)) {
        throw new Error('simulated disk full');
      }
      return actual.writeFileSync(path as never, data as never, opts as never);
    },
    renameSync: (from: unknown, to: unknown) => {
      renameCalls.push([from, to]);
      if (renameShouldThrowForTarget !== undefined && to === renameShouldThrowForTarget) {
        throw new Error('simulated crash before rename');
      }
      return actual.renameSync(from as never, to as never);
    },
    unlinkSync: (path: unknown) => {
      unlinkCalls.push(path);
      if (unlinkShouldThrow) throw new Error('simulated permission denied');
      return actual.unlinkSync(path as never);
    },
  };
});

const { commitImport } = await import('../../../src/storage/import-commit.js');
const { listSecrets } = await import('../../../src/storage/manager.js');
const { existsSync: realExistsSync, readFileSync: realReadFileSync } = await import('node:fs');

function entry(name: string, value: string): ParsedDotEnvEntry {
  return { name, value, ambiguous: false };
}

describe('commitImport (fs-mocked edge cases, Issue #13 review round 2)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    envFilePath = join(tmpProject, '.env');
    readFileOverride = undefined;
    renameShouldThrowForTarget = undefined;
    unlinkShouldThrow = false;
    writeShouldThrowForEnvPath = undefined;
    renameCalls.length = 0;
    unlinkCalls.length = 0;
    writeCalls.length = 0;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    readFileOverride = undefined;
    renameShouldThrowForTarget = undefined;
    unlinkShouldThrow = false;
    writeShouldThrowForEnvPath = undefined;
  });

  describe('B1: parse/rewrite interleaving', () => {
    it('a value edited on disk between parse and rewrite is never lost — left in place and reported, not removed', async () => {
      writeFileSync(envFilePath, 'DB_PASSWORD=original-value\nUNRELATED=1\n');

      let rewriteTimeReadSeen = false;
      readFileOverride = (path) => {
        if (path !== envFilePath) return undefined;
        // First read is commitImport's own rewrite-time re-parse; simulate the
        // user having edited the file on disk since the CLI/MCP layer parsed
        // 'original-value' and handed it to commitImport.
        if (!rewriteTimeReadSeen) {
          rewriteTimeReadSeen = true;
          return 'DB_PASSWORD=edited-after-parse\nUNRELATED=1\n';
        }
        return undefined;
      };

      const result = await commitImport({
        entries: [entry('DB_PASSWORD', 'original-value')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['DB_PASSWORD']);
      expect(result.skippedMismatch).toEqual(['DB_PASSWORD']);
      expect(result.fileRewritten).toBe(false);
      expect(result.warnings.some((w) => w.includes('DB_PASSWORD') && w.includes('changed before the file could be rewritten'))).toBe(true);

      // The secret DID migrate successfully — that's the point: a mismatch skips the FILE edit, never the depository write.
      expect(listSecrets({ scope: 'all', cwd: tmpProject }).map((e) => e.name)).toEqual(['DB_PASSWORD']);
      // A mismatch means no write is ever attempted, so the file on disk is untouched —
      // exactly what it held before this call, not what the (simulated) rewrite-time
      // read reported seeing.
      expect(realReadFileSync(envFilePath, 'utf8')).toBe('DB_PASSWORD=original-value\nUNRELATED=1\n');
    });

    it('a line already removed by the time of rewrite is simply skipped, with no false mismatch warning', async () => {
      writeFileSync(envFilePath, 'DB_PASSWORD=original-value\nUNRELATED=1\n');

      let rewriteTimeReadSeen = false;
      readFileOverride = (path) => {
        if (path !== envFilePath) return undefined;
        if (!rewriteTimeReadSeen) {
          rewriteTimeReadSeen = true;
          return 'UNRELATED=1\n';
        }
        return undefined;
      };

      const result = await commitImport({
        entries: [entry('DB_PASSWORD', 'original-value')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['DB_PASSWORD']);
      expect(result.skippedMismatch).toEqual([]);
      expect(result.fileRewritten).toBe(false);
      expect(result.warnings.some((w) => w.includes('DB_PASSWORD'))).toBe(false);
    });
  });

  describe('A1: atomic rewrite', () => {
    it('a failure during the rename step never leaves the original file corrupted or truncated, and never throws — reported via warnings instead', async () => {
      const original = '# header\nKEEP_ME=1\nOPENAI_API_KEY=sk-abc\n';
      writeFileSync(envFilePath, original);
      renameShouldThrowForTarget = envFilePath;

      const result = await commitImport({
        entries: [entry('OPENAI_API_KEY', 'sk-abc')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      // The depository write already succeeded — that's expected and not what's under
      // test. What matters: the file on disk is exactly what it was, never truncated
      // or half-swapped, and the failure is reported rather than thrown.
      expect(result.succeeded).toEqual(['OPENAI_API_KEY']);
      expect(result.fileRewritten).toBe(false);
      expect(result.warnings.some((w) => w.includes('Failed to rewrite') && w.includes('simulated crash before rename'))).toBe(true);
      expect(realReadFileSync(envFilePath, 'utf8')).toBe(original);
    });

    it('a failure during the initial temp-file write (before rename is ever reached) never leaves the original file corrupted, and never throws (Issue #13 review, round 4, QA advisory b)', async () => {
      const original = '# header\nKEEP_ME=1\nOPENAI_API_KEY=sk-abc\n';
      writeFileSync(envFilePath, original);
      writeShouldThrowForEnvPath = envFilePath;

      const result = await commitImport({
        entries: [entry('OPENAI_API_KEY', 'sk-abc')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['OPENAI_API_KEY']);
      expect(result.fileRewritten).toBe(false);
      expect(result.warnings.some((w) => w.includes('Failed to rewrite') && w.includes('simulated disk full'))).toBe(true);
      expect(realReadFileSync(envFilePath, 'utf8')).toBe(original);
      // The temp write never landed anything to clean up — no rename was ever reached, so no rename call happened for this path.
      expect(renameCalls.some(([, to]) => to === envFilePath)).toBe(false);
    });

    describe('item 2: temp file cleanup (Issue #13 review, round 3)', () => {
      it('a plaintext temp file left behind by a failed rename is cleaned up automatically', async () => {
        writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');
        renameShouldThrowForTarget = envFilePath;

        await commitImport({
          entries: [entry('OPENAI_API_KEY', 'sk-abc')],
          depository: 'encrypted',
          scope: 'project',
          cwd: tmpProject,
          projectPath: tmpProject,
          envFilePath,
          actor: 'cli',
        });

        // Issue #66: setSecret's index write now goes through mutateIndex,
        // whose `release()` calls unlinkSync on the lock file in `finally`
        // — so the mock sees an extra unlink for `index.lock` that this
        // test never asked about. Filter to the .env rewrite's own temp
        // files, the same way the renameCalls check above already does.
        const envUnlinks = unlinkCalls.filter((p) => typeof p === 'string' && isOwnTempFile(p, envFilePath));
        expect(envUnlinks).toHaveLength(1);
        const [tmpPath] = renameCalls.filter(([, to]) => to === envFilePath)[0]!;
        expect(realExistsSync(tmpPath as string)).toBe(false);
      });

      it('when the cleanup itself also fails, the leftover path is named in warnings rather than swallowed', async () => {
        writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');
        renameShouldThrowForTarget = envFilePath;
        unlinkShouldThrow = true;

        const result = await commitImport({
          entries: [entry('OPENAI_API_KEY', 'sk-abc')],
          depository: 'encrypted',
          scope: 'project',
          cwd: tmpProject,
          projectPath: tmpProject,
          envFilePath,
          actor: 'cli',
        });

        const [tmpPath] = renameCalls.filter(([, to]) => to === envFilePath)[0]!;
        expect(result.warnings.some((w) => w.includes(String(tmpPath)) && w.includes('could not be removed automatically'))).toBe(true);
        // The leftover really is still there — this test's own cleanup below removes it for real.
        expect(realExistsSync(tmpPath as string)).toBe(true);
        rmSync(tmpPath as string, { force: true });
      });
    });

    it('renames a sibling temp file onto the target rather than truncating it in place', async () => {
      writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');

      await commitImport({
        entries: [entry('OPENAI_API_KEY', 'sk-abc')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      const envRenames = renameCalls.filter(([, to]) => to === envFilePath);
      expect(envRenames).toHaveLength(1);
      const [from, to] = envRenames[0]!;
      expect(to).toBe(envFilePath);
      expect(String(from)).not.toBe(envFilePath);
      expect(String(from)).toMatch(new RegExp(`^${envFilePath}\\.[0-9a-f]+\\.tmp$`));
    });
  });
});
