import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdImport } from '../../../../src/cli/commands/import.js';
import { RequestStore } from '../../../../src/request/store.js';
import { listSecrets } from '../../../../src/storage/manager.js';
import { startServer, stopServer } from '../../../../src/web/server.js';

// Wraps every ServerHandle.startServer() returns so tests can count close()
// calls and inject a close failure — the handle is created inside cmdImport,
// so this module mock is the only way to observe it (PR #78 review blocker:
// the handle must be closed exactly once on every path, and a close failure
// must not mask the primary waiter error).
const serverMock = vi.hoisted(() => ({
  closeCount: 0,
  failNextClose: false,
}));

vi.mock('../../../../src/web/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/web/server.js')>();
  return {
    ...actual,
    startServer: vi.fn(async (opts?: Parameters<typeof actual.startServer>[0]) => {
      const handle = await actual.startServer(opts);
      return {
        ...handle,
        close: vi.fn(async () => {
          serverMock.closeCount += 1;
          if (serverMock.failNextClose) {
            serverMock.failNextClose = false;
            throw new Error('close boom');
          }
          return handle.close();
        }),
      };
    }),
  };
});

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('cmdImport', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let envFilePath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    envFilePath = join(tmpProject, '.env');
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    RequestStore.__resetForTests();
    serverMock.closeCount = 0;
    serverMock.failNextClose = false;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('rejects more than one positional with UsageError', async () => {
    const { UsageError } = await import('../../../../src/cli/args.js');
    await expect(cmdImport(['.env', 'extra'])).rejects.toThrow(UsageError);
  });

  it('rejects a missing file with E_NOT_FOUND', async () => {
    await expect(cmdImport(['.env', '--depository', 'encrypted'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
  });

  it('AC1: --depository encrypted imports every key, rewrites the file, warns about a missing .gitignore, and never prints the value', async () => {
    writeFileSync(
      envFilePath,
      `# a header comment, kept as-is\n\nOPENAI_API_KEY=${SENTINEL}\nGITHUB_TOKEN=ghp-xyz\nlower_case_ignored=untouched\n`,
    );

    const code = await cmdImport(['.env', '--depository', 'encrypted']);

    expect(code).toBe(0);
    const output = stdoutText();
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain('OPENAI_API_KEY');
    expect(output).toContain('warning:');
    expect(output).toContain('lower_case_ignored');

    const rewritten = readFileSync(envFilePath, 'utf8');
    expect(rewritten).toContain('# a header comment, kept as-is\n');
    expect(rewritten).toContain('lower_case_ignored=untouched\n');
    expect(rewritten).not.toContain(SENTINEL);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });

  it('AC2: --depository env moves values into the managed block only', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);

    const code = await cmdImport(['.env', '--depository', 'env']);

    expect(code).toBe(0);
    const rewritten = readFileSync(envFilePath, 'utf8');
    expect(rewritten).toContain('# enigma:begin');
    expect(rewritten.match(new RegExp(SENTINEL, 'g'))).toHaveLength(1);
  });

  it('AC4: --json includes warnings[] for a missing .gitignore', async () => {
    writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');

    await cmdImport(['.env', '--depository', 'encrypted', '--json']);

    const parsed = JSON.parse(stdoutText()) as { warnings: string[]; imported: string[] };
    expect(parsed.imported).toEqual(['OPENAI_API_KEY']);
    expect(parsed.warnings.some((w) => w.includes('.env is not gitignored'))).toBe(true);
  });

  it('emits nothing destructive and exits 0 when the file has no importable keys', async () => {
    writeFileSync(envFilePath, '# just a comment\n');
    const code = await cmdImport(['.env', '--depository', 'encrypted']);
    expect(code).toBe(0);
    expect(readFileSync(envFilePath, 'utf8')).toBe('# just a comment\n');
  });

  it('a partial failure leaves .env untouched and exits 1', async () => {
    writeFileSync(envFilePath, 'OPENAI_API_KEY=first\n');
    await cmdImport(['.env', '--depository', 'encrypted']);
    writeFileSync(envFilePath, 'OPENAI_API_KEY=second\nGITHUB_TOKEN=ghp-xyz\n');

    const code = await cmdImport(['.env', '--depository', 'encrypted']);

    expect(code).toBe(1);
    expect(readFileSync(envFilePath, 'utf8')).toBe('OPENAI_API_KEY=second\nGITHUB_TOKEN=ghp-xyz\n');
  });

  it('Issue #42: a partial failure into a non-env depository warns which secrets are already stored, naming the depository (not env-only)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    await cmdImport(['.env', '--depository', 'encrypted']);
    // GITHUB_TOKEN listed first so it succeeds before OPENAI_API_KEY (already stored above) aborts the batch.
    writeFileSync(envFilePath, `GITHUB_TOKEN=ghp-xyz\nOPENAI_API_KEY=${SENTINEL}\n`);

    stdoutSpy.mockClear();
    const code = await cmdImport(['.env', '--depository', 'encrypted', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { warnings: string[] };
    const warning = parsed.warnings.find((w) => w.includes('already stored in encrypted'));
    expect(warning).toBeDefined();
    expect(warning).toContain('GITHUB_TOKEN');
    expect(warning).not.toContain(SENTINEL);
  });

  it('Issue #42: --rotate lets a rerun after a partial failure actually succeed — the tool\'s own printed remediation now works', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    await cmdImport(['.env', '--depository', 'encrypted']);
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\nGITHUB_TOKEN=ghp-xyz\n`);

    stdoutSpy.mockClear();
    const withoutRotate = await cmdImport(['.env', '--depository', 'encrypted', '--json']);
    expect(withoutRotate).toBe(1);
    expect(JSON.parse(stdoutText()).failed).toEqual([{ name: 'OPENAI_API_KEY', errorCode: 'E_EXISTS', message: expect.stringContaining('already exists') }]);

    stdoutSpy.mockClear();
    const withRotate = await cmdImport(['.env', '--depository', 'encrypted', '--rotate', '--json']);
    expect(withRotate).toBe(0);
    const parsed = JSON.parse(stdoutText()) as { imported: string[] };
    expect(parsed.imported.sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expect(readFileSync(envFilePath, 'utf8')).not.toContain(SENTINEL);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });

  it('A2: an ambiguous unquoted value (space-hash) refuses through the loud-abort path, .env untouched, exit 1', async () => {
    writeFileSync(envFilePath, 'PORT=3000 # dev port\n');

    const code = await cmdImport(['.env', '--depository', 'encrypted', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { failed: Array<{ name: string; errorCode: string; message?: string }> };
    expect(parsed.failed).toEqual([{ name: 'PORT', errorCode: 'E_VALUE_AMBIGUOUS', message: expect.stringContaining('quote the value') }]);
    expect(readFileSync(envFilePath, 'utf8')).toBe('PORT=3000 # dev port\n');
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
  });

  it('A2: a quoted value containing "#" migrates intact and is unaffected by the ambiguity check', async () => {
    writeFileSync(envFilePath, 'TOKEN="abc#def"\n');

    const code = await cmdImport(['.env', '--depository', 'encrypted']);

    expect(code).toBe(0);
    expect(readFileSync(envFilePath, 'utf8')).not.toContain('abc#def');
    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name)).toEqual(['TOKEN']);
  });

  it('duplicate key: text output refuses through the loud-abort path, names the key, exits 1, and leaves both lines untouched (Issue #13 review, round 4)', async () => {
    const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
    writeFileSync(envFilePath, original);

    const code = await cmdImport(['.env', '--depository', 'encrypted']);

    expect(code).toBe(1);
    const output = stdoutText();
    expect(output).toContain('API_KEY');
    expect(output).toContain('assigned more than once');
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
  });

  it('duplicate key: --json surfaces the same refusal in failed[] with the key named (Issue #13 review, round 4)', async () => {
    const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
    writeFileSync(envFilePath, original);

    const code = await cmdImport(['.env', '--depository', 'encrypted', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { failed: Array<{ name: string; errorCode: string; message?: string }> };
    expect(parsed.failed).toEqual([
      { name: 'API_KEY', errorCode: 'E_VALUE_AMBIGUOUS', message: expect.stringContaining('assigned more than once') },
    ]);
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
  });

  it('AC3: without --depository, starts the server, prints a URL, and completes once the picker is submitted', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);

    const importPromise = cmdImport(['.env']);

    // Wait for the CLI to create the RequestStore record and print the URL.
    await vi.waitFor(() => {
      expect(stderrSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('/i/'))).toBe(true);
    });

    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const match = printed.match(/\/i\/([0-9a-f]{32})/);
    expect(match).not.toBeNull();
    const id = match![1]!;

    const handle = await startServer();
    const postResp = await fetch(`${handle.origin}/i/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: 'encrypted' }).toString(),
    });
    expect(postResp.status).toBe(200);

    const code = await importPromise;
    expect(code).toBe(0);
    expect(stdoutText()).not.toContain(SENTINEL);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name)).toEqual(['OPENAI_API_KEY']);

    // Issue #13 review, round 4, finding 1: cmdImport must close its own server handle
    // once the browser flow completes — otherwise the listening socket keeps the event
    // loop alive and the process never exits (process.exitCode alone only takes effect
    // once the loop drains). Proven by starting a fresh server afterwards: if the
    // previous one were still open, startServer() would just return that same instance
    // (same origin) rather than binding a new port.
    const handleAfter = await startServer();
    expect(handleAfter.origin).not.toBe(handle.origin);
  });

  it('duplicate key via the browser picker default flow surfaces the same reason as --depository, and closes the server on completion (Issue #13 review, round 4, findings 1 & 2)', async () => {
    const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
    writeFileSync(envFilePath, original);

    const importPromise = cmdImport(['.env']);

    await vi.waitFor(() => {
      expect(stderrSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('/i/'))).toBe(true);
    });
    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const id = printed.match(/\/i\/([0-9a-f]{32})/)![1]!;

    const handle = await startServer();
    const postResp = await fetch(`${handle.origin}/i/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: 'encrypted' }).toString(),
    });
    expect(postResp.status).toBe(200);

    const code = await importPromise;

    expect(code).toBe(1);
    const output = stdoutText();
    expect(output).toContain('API_KEY');
    expect(output).toContain('assigned more than once');
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);

    const handleAfter = await startServer();
    expect(handleAfter.origin).not.toBe(handle.origin);
  });

  it('waiter rejection with RequestExpiredError exits 1 with a distinguishable code in --json and closes the handle exactly once (PR #78 review blocker)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\nGITHUB_TOKEN=ghp-xyz\n`);
    const { RequestExpiredError } = await import('../../../../src/request/store.js');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(new RequestExpiredError());

    const code = await cmdImport(['.env', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as {
      error?: { code: string; message: string };
      imported: string[];
      notAttempted: string[];
    };
    expect(parsed.error?.code).toBe('E_REQUEST_EXPIRED');
    expect(parsed.imported).toEqual([]);
    // Never-used expiry: no submission ran, so every name was genuinely not attempted.
    expect(parsed.notAttempted.sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expect(stdoutText()).not.toContain(SENTINEL);
    expect(serverMock.closeCount).toBe(1);
    // Nothing was written through the picker path.
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
  });

  it('waiter rejection with RequestExpiredError in text mode prints the E_REQUEST_EXPIRED diagnostic and exits 1', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const { RequestExpiredError } = await import('../../../../src/request/store.js');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(new RequestExpiredError());

    const code = await cmdImport(['.env']);

    expect(code).toBe(1);
    const output = stdoutText();
    expect(output).toContain('E_REQUEST_EXPIRED');
    expect(output).toContain('expired');
    expect(output).toContain('OPENAI_API_KEY');
    expect(output).not.toContain(SENTINEL);
    expect(serverMock.closeCount).toBe(1);
  });

  it('waiter rejection with OutcomeUnknownError exits 1 as E_OUTCOME_UNKNOWN and does NOT claim the names were never attempted (PR #78 review blocker)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const { OutcomeUnknownError } = await import('../../../../src/request/store.js');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(new OutcomeUnknownError(['OPENAI_API_KEY']));

    const code = await cmdImport(['.env', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as {
      error?: { code: string; message: string };
      notAttempted: string[];
    };
    expect(parsed.error?.code).toBe('E_OUTCOME_UNKNOWN');
    expect(parsed.error?.message).toContain('enigma list');
    // The form was used — writes may already have happened, so nothing may
    // be labelled "not attempted".
    expect(parsed.notAttempted).toEqual([]);
    expect(stdoutText()).not.toContain(SENTINEL);
    expect(serverMock.closeCount).toBe(1);
  });

  it('OutcomeUnknownError in text mode prints the E_OUTCOME_UNKNOWN diagnostic and exits 1', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const { OutcomeUnknownError } = await import('../../../../src/request/store.js');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(new OutcomeUnknownError(['OPENAI_API_KEY']));

    const code = await cmdImport(['.env']);

    expect(code).toBe(1);
    const output = stdoutText();
    expect(output).toContain('E_OUTCOME_UNKNOWN');
    expect(output).not.toContain('not attempted');
    expect(output).not.toContain(SENTINEL);
    expect(serverMock.closeCount).toBe(1);
  });

  it('an unexpected waiter error propagates unchanged after the handle is closed — never fabricated into a success report', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const boom = new Error('socket exploded');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(boom);

    await expect(cmdImport(['.env', '--json'])).rejects.toBe(boom);

    // Handle still closed exactly once, and no success-shaped report was printed.
    expect(serverMock.closeCount).toBe(1);
    expect(stdoutText()).toBe('');
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
  });

  it('a close failure during error cleanup preserves the primary waiter error (stderr warning, still the E_REQUEST_EXPIRED report)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    serverMock.failNextClose = true;
    const { RequestExpiredError } = await import('../../../../src/request/store.js');
    vi.spyOn(RequestStore, 'waitForFulfilled').mockRejectedValueOnce(new RequestExpiredError());

    const code = await cmdImport(['.env', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { error?: { code: string } };
    expect(parsed.error?.code).toBe('E_REQUEST_EXPIRED');
    const errOut = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(errOut).toContain('warning');
    expect(serverMock.closeCount).toBe(1);
  });
});
