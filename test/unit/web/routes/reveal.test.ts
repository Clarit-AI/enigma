import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, stopServer } from '../../../../src/web/server.js';
import { RequestStore } from '../../../../src/request/store.js';
import { setSecret } from '../../../../src/storage/manager.js';
import { auditLogPath } from '../../../../src/core/paths.js';

describe('GET /v/:id, POST /v/:id/reveal', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let origin: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
    origin = (await startServer()).origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('GET returns 404 for a request-kind id (route/kind mismatch)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/v/${record.id}`);
    expect(resp.status).toBe(404);
  });

  it('GET returns 410 once the id has been used', async () => {
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);

    const resp = await fetch(`${origin}/v/${record.id}`);
    expect(resp.status).toBe(410);
  });

  it('POST /reveal for a name that was never set returns 404 without an audit line', async () => {
    const record = RequestStore.create({ kind: 'reveal', names: ['NEVER_SET'], scope: 'global' });
    const resp = await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });

    expect(resp.status).toBe(404);
    // Nothing was ever resolved, so the audit log was never even created.
    expect(existsSync(auditLogPath())).toBe(false);
  });

  it('a successful reveal records audit op "reveal", not "read"', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'], scope: 'global' });

    const resp = await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });
    expect(resp.status).toBe(200);

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; method?: string });
    const revealLine = lines.find((l) => l.op === 'reveal' && l.name === 'OPENAI_API_KEY');
    expect(revealLine).toBeDefined();
    expect(lines.some((l) => l.op === 'read')).toBe(false);
  });

  it('a successful reveal records method "page", distinguishing it from a clipboard reveal (Issue #26)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'], scope: 'global' });

    const resp = await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });
    expect(resp.status).toBe(200);

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; method?: string });
    const revealLine = lines.find((l) => l.op === 'reveal' && l.name === 'OPENAI_API_KEY');
    expect(revealLine?.method).toBe('page');
  });

  it('POST /reveal on an already-used id returns 410 and does not resolve again', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'], scope: 'global' });

    await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });
    const replay = await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });

    expect(replay.status).toBe(410);
  });
});
