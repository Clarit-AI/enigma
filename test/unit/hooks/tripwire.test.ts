import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexEntry, IndexFile } from '../../../src/core/index-store.js';

/** Controls per-test what each fake depository's `resolve(ref)` returns/throws,
 * keyed `"<depositoryId>:<ref>"`, and records every `create()` call so tests can
 * assert which depositories were actually touched (not just what config allows). */
let resolveResponses: Record<string, string | Error> = {};
let resolveSideEffects: Record<string, () => void> = {};
let createCalls: string[] = [];

function makeFakeModule(id: string) {
  return {
    id,
    promptProfile: 'none',
    async detect() {
      return { id, promptProfile: 'none', available: true };
    },
    create() {
      createCalls.push(id);
      return {
        id,
        promptProfile: 'none',
        async resolve(ref: string) {
          resolveSideEffects[`${id}:${ref}`]?.();
          const resp = resolveResponses[`${id}:${ref}`];
          if (resp instanceof Error) throw resp;
          if (resp === undefined) throw new Error(`fake ${id} depository: no response configured for ref ${ref}`);
          return resp;
        },
        async set(): Promise<string> {
          throw new Error('not used by tripwire tests');
        },
        async delete(): Promise<void> {
          throw new Error('not used by tripwire tests');
        },
        async has(): Promise<boolean> {
          return true;
        },
      };
    },
  };
}

vi.mock('../../../src/storage/detect.js', () => ({
  DEPOSITORY_MODULES: ['encrypted', 'env', 'keychain', 'secret-service', '1password'].map((id) => makeFakeModule(id)),
}));

const { runTripwire } = await import('../../../src/hooks/tripwire.js');
const { indexPath, configPath, auditLogPath } = await import('../../../src/core/paths.js');
const { projectId: computeProjectId } = await import('../../../src/core/project.js');

const OTHER_PROJECT_ID = 'b'.repeat(16);

function writeIndexFile(entries: IndexEntry[]): void {
  const index: IndexFile = { version: 1, entries };
  writeFileSync(indexPath(), JSON.stringify(index));
}

function writeConfigFile(config: unknown): void {
  writeFileSync(configPath(), JSON.stringify(config));
}

function readAuditOps(): { op: string; name: string }[] {
  try {
    return readFileSync(auditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; name: string });
  } catch {
    return [];
  }
}

function entry(overrides: Partial<IndexEntry> & Pick<IndexEntry, 'name' | 'scope' | 'depository' | 'ref'>): IndexEntry {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PostToolUse tripwire', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const cwd = '/repo/current-project';

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    resolveResponses = {};
    resolveSideEffects = {};
    createCalls = [];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reports a hit, names the secret, and audits op leak (actor hook)', async () => {
    writeIndexFile([
      entry({ name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', ref: 'global/OPENAI_API_KEY' }),
    ]);
    resolveResponses['encrypted:global/OPENAI_API_KEY'] = 'sk-leaked-sentinel-value';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'here is sk-leaked-sentinel-value oops', stderr: '' },
      cwd,
    });

    expect(result?.systemMessage).toContain('LEAK: value of OPENAI_API_KEY appeared in tool output');
    expect(result?.systemMessage).toContain('rotate it via enigma_request rotate:true');

    const audit = readAuditOps();
    expect(audit).toContainEqual(expect.objectContaining({ op: 'leak', name: 'OPENAI_API_KEY' }));
  });

  it('returns undefined and writes no audit event when nothing matches', async () => {
    writeIndexFile([entry({ name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', ref: 'global/OPENAI_API_KEY' })]);
    resolveResponses['encrypted:global/OPENAI_API_KEY'] = 'sk-not-present-anywhere';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'nothing to see here', stderr: '' },
      cwd,
    });

    expect(result).toBeUndefined();
    expect(readAuditOps()).toHaveLength(0);
  });

  it('scans the env depository by default alongside encrypted', async () => {
    writeIndexFile([entry({ name: 'DB_PASSWORD', scope: 'global', depository: 'env', ref: 'DB_PASSWORD' })]);
    resolveResponses['env:DB_PASSWORD'] = 'hunter2-but-longer';

    const result = await runTripwire({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: 'the value is hunter2-but-longer here',
      cwd,
    });

    expect(result?.systemMessage).toContain('DB_PASSWORD');
  });

  it('does not scan keychain by default even when a keychain secret would match', async () => {
    writeIndexFile([entry({ name: 'KEYCHAIN_SECRET', scope: 'global', depository: 'keychain', ref: 'global/KEYCHAIN_SECRET' })]);
    resolveResponses['keychain:global/KEYCHAIN_SECRET'] = 'keychain-sentinel-value';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: 'contains keychain-sentinel-value',
      cwd,
    });

    expect(result).toBeUndefined();
    expect(createCalls).not.toContain('keychain');
  });

  it('scans keychain when config.tripwire.depositories explicitly includes it', async () => {
    writeConfigFile({ tripwire: { depositories: ['keychain'] } });
    writeIndexFile([entry({ name: 'KEYCHAIN_SECRET', scope: 'global', depository: 'keychain', ref: 'global/KEYCHAIN_SECRET' })]);
    resolveResponses['keychain:global/KEYCHAIN_SECRET'] = 'keychain-sentinel-value';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: 'contains keychain-sentinel-value',
      cwd,
    });

    expect(result?.systemMessage).toContain('KEYCHAIN_SECRET');
    expect(createCalls).toContain('keychain');
  });

  it('scans secret-service only when explicitly configured, same as keychain', async () => {
    writeIndexFile([entry({ name: 'LINUX_SECRET', scope: 'global', depository: 'secret-service', ref: 'global/LINUX_SECRET' })]);
    resolveResponses['secret-service:global/LINUX_SECRET'] = 'linux-sentinel-value';

    const withoutConfig = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'contains linux-sentinel-value',
      cwd,
    });
    expect(withoutConfig).toBeUndefined();

    writeConfigFile({ tripwire: { depositories: ['secret-service'] } });
    const withConfig = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'contains linux-sentinel-value',
      cwd,
    });
    expect(withConfig?.systemMessage).toContain('LINUX_SECRET');
  });

  it('never scans 1password even when config.tripwire.depositories explicitly lists it', async () => {
    writeConfigFile({ tripwire: { depositories: ['1password'] } });
    writeIndexFile([entry({ name: 'OP_SECRET', scope: 'global', depository: '1password', ref: 'item-id' })]);
    resolveResponses['1password:item-id'] = 'op-sentinel-value';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'contains op-sentinel-value',
      cwd,
    });

    expect(result).toBeUndefined();
    expect(createCalls).not.toContain('1password');
  });

  it('ignores a match shorter than the minimum secret length to avoid false positives', async () => {
    writeIndexFile([entry({ name: 'SHORT', scope: 'global', depository: 'encrypted', ref: 'global/SHORT' })]);
    resolveResponses['encrypted:global/SHORT'] = 'ab12'; // 4 chars, below the 6-char floor

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'ab12 appears right here',
      cwd,
    });

    expect(result).toBeUndefined();
    expect(readAuditOps()).toHaveLength(0);
  });

  it('skips scanning entirely when tool output exceeds 1 MB', async () => {
    writeIndexFile([entry({ name: 'BIG', scope: 'global', depository: 'encrypted', ref: 'global/BIG' })]);
    resolveResponses['encrypted:global/BIG'] = 'sk-should-not-be-checked';

    const huge = 'x'.repeat(1_000_001);
    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: huge,
      cwd,
    });

    expect(result).toBeUndefined();
    expect(createCalls).toHaveLength(0);
  });

  it('fails open when a depository resolve throws', async () => {
    writeIndexFile([entry({ name: 'BROKEN', scope: 'global', depository: 'encrypted', ref: 'global/BROKEN' })]);
    resolveResponses['encrypted:global/BROKEN'] = new Error('boom');

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'anything at all',
      cwd,
    });

    expect(result).toBeUndefined();
  });

  it('scans a secret scoped to the current project', async () => {
    const pid = computeProjectId(cwd);
    writeIndexFile([
      entry({
        name: 'THIS_PROJECT_SECRET',
        scope: 'project',
        projectId: pid,
        projectPath: cwd,
        depository: 'encrypted',
        ref: `${pid}/THIS_PROJECT_SECRET`,
      }),
    ]);
    resolveResponses[`encrypted:${pid}/THIS_PROJECT_SECRET`] = 'sk-this-project-sentinel';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'contains sk-this-project-sentinel',
      cwd,
    });

    expect(result?.systemMessage).toContain('THIS_PROJECT_SECRET');
  });

  it('does not scan another project scoped secret', async () => {
    writeIndexFile([
      entry({
        name: 'OTHER_PROJECT_SECRET',
        scope: 'project',
        projectId: OTHER_PROJECT_ID,
        projectPath: '/repo/other-project',
        depository: 'encrypted',
        ref: `${OTHER_PROJECT_ID}/OTHER_PROJECT_SECRET`,
      }),
    ]);
    resolveResponses[`encrypted:${OTHER_PROJECT_ID}/OTHER_PROJECT_SECRET`] = 'sk-other-project-sentinel';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'contains sk-other-project-sentinel',
      cwd,
    });

    expect(result).toBeUndefined();
    expect(createCalls).toHaveLength(0);
  });

  it('reports one leak line and one audit event per matched name when several secrets leak at once', async () => {
    writeIndexFile([
      entry({ name: 'FIRST_SECRET', scope: 'global', depository: 'encrypted', ref: 'global/FIRST_SECRET' }),
      entry({ name: 'SECOND_SECRET', scope: 'global', depository: 'env', ref: 'SECOND_SECRET' }),
    ]);
    resolveResponses['encrypted:global/FIRST_SECRET'] = 'sk-sentinel-one-value';
    resolveResponses['env:SECOND_SECRET'] = 'sk-sentinel-two-value';

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'sk-sentinel-one-value and sk-sentinel-two-value both leaked',
      cwd,
    });

    expect(result?.systemMessage.split('\n')).toHaveLength(2);
    expect(result?.systemMessage).toContain('FIRST_SECRET');
    expect(result?.systemMessage).toContain('SECOND_SECRET');
    expect(readAuditOps().filter((a) => a.op === 'leak')).toHaveLength(2);
  });

  it('caps total runtime to ~5s: a candidate whose resolve stalls past the budget stops the scan of later candidates', async () => {
    vi.useFakeTimers();
    try {
      writeIndexFile([
        entry({ name: 'SLOW_FIRST', scope: 'global', depository: 'encrypted', ref: 'global/SLOW_FIRST' }),
        entry({ name: 'NEVER_CHECKED_SECOND', scope: 'global', depository: 'encrypted', ref: 'global/NEVER_CHECKED_SECOND' }),
      ]);
      resolveResponses['encrypted:global/SLOW_FIRST'] = 'sk-first-does-not-match';
      resolveResponses['encrypted:global/NEVER_CHECKED_SECOND'] = 'sk-second-would-match-if-checked';
      // Simulates a slow depository call by jumping the (fake) clock past the
      // 5s budget as a side effect of the first candidate's resolve() — proving
      // the budget is enforced by elapsed time, not by a fixed candidate count.
      resolveSideEffects['encrypted:global/SLOW_FIRST'] = () => {
        vi.advanceTimersByTime(6000);
      };

      const result = await runTripwire({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: 'contains sk-second-would-match-if-checked',
        cwd,
      });

      expect(result).toBeUndefined();
      expect(createCalls).toEqual(['encrypted']);
    } finally {
      vi.useRealTimers();
    }
  });
});
