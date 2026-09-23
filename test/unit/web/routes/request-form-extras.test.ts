import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, stopServer } from '../../../../src/web/server.js';
import { RequestStore, getSkippedNameCount } from '../../../../src/request/store.js';
import { listSecrets, setSecret } from '../../../../src/storage/manager.js';

// Issue #71 — the extensible request form: `+ Add secret` rows
// (extra_name_N / extra_value_N) and a pasted `dotenv_blob`, parsed on submit.
// Every invariant here traces to the plan's Decision 3 table.

const SENTINEL_NAME = 'sk-sentinel-name-should-never-appear';

describe('POST /r/:id — extra rows and pasted .env blob (Issue #71)', () => {
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

  function submit(id: string, fields: Array<[string, string]>, extra: Record<string, string> = {}): Promise<Response> {
    const params = new URLSearchParams({ depository: 'encrypted', scope: 'global', ...extra });
    for (const [key, value] of fields) params.append(key, value);
    return fetch(`${origin}/r/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  }

  function storedNames(): string[] {
    return listSecrets({ scope: 'all', cwd: process.cwd() }).map((e) => e.name).sort();
  }

  it('a Neon-style blob stores every valid key; extras carry addedByUser, the declared name does not', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['DATABASE_URL'] });
    const blob = [
      '# copied from the Neon dashboard',
      'DIRECT_URL="postgres://user:pw@host/db?sslmode=require"',
      'PGHOST=ep-cool-123.neon.tech',
      "PGUSER='neondb_owner'",
      'export PGDATABASE=neondb',
    ].join('\n');

    const resp = await submit(record.id, [['DATABASE_URL', 'postgres://pooled'], ['dotenv_blob', blob]]);
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(RequestStore.get(record.id)?.results).toEqual([
      { name: 'DATABASE_URL', ok: true },
      { name: 'DIRECT_URL', ok: true, addedByUser: true },
      { name: 'PGHOST', ok: true, addedByUser: true },
      { name: 'PGUSER', ok: true, addedByUser: true },
      { name: 'PGDATABASE', ok: true, addedByUser: true },
    ]);
    expect(storedNames()).toEqual(['DATABASE_URL', 'DIRECT_URL', 'PGDATABASE', 'PGHOST', 'PGUSER']);
    expect(html).toContain('DIRECT_URL (added by you)');
    expect(html).not.toContain('postgres://');
  });

  it('manual extra rows are stored in row-number order (numeric, not lexical), sharing the form depository and scope', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    await submit(record.id, [
      ['OPENAI_API_KEY', 'v0'],
      ['extra_name_10', 'TENTH'],
      ['extra_value_10', 'v10'],
      ['extra_name_2', 'SECOND'],
      ['extra_value_2', 'v2'],
    ]);

    expect(RequestStore.get(record.id)?.results?.map((r) => r.name)).toEqual(['OPENAI_API_KEY', 'SECOND', 'TENTH']);
    const entries = listSecrets({ scope: 'all', cwd: process.cwd() });
    expect(entries.every((e) => e.scope === 'global' && e.depository === 'encrypted')).toBe(true);
  });

  it('a blank extra row (both fields empty) is ignored, not reported as anything', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const resp = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['extra_name_1', ''], ['extra_value_1', '']]);

    expect(RequestStore.get(record.id)?.results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);
    expect(getSkippedNameCount(RequestStore.get(record.id)!.results!)).toBe(0);
    expect(await resp.text()).not.toContain('skipped');
  });

  it('an extra row with a valid name but no value fails per name with E_MISSING_VALUE', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['extra_name_1', 'NO_VALUE'], ['extra_value_1', '']]);

    expect(RequestStore.get(record.id)?.results).toEqual([
      { name: 'OPENAI_API_KEY', ok: true },
      { name: 'NO_VALUE', ok: false, errorCode: 'E_MISSING_VALUE', addedByUser: true },
    ]);
  });

  describe('invalid names are counted, never echoed', () => {
    it('manual rows: an invalid name (or over-long one) is counted, has no RequestNameResult, and its text appears nowhere in the response', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      const resp = await submit(record.id, [
        ['OPENAI_API_KEY', 'v0'],
        ['extra_name_1', SENTINEL_NAME],
        ['extra_value_1', 'value-1'],
        ['extra_name_2', 'lowercase_name'],
        ['extra_value_2', 'value-2'],
        ['extra_name_3', 'A'.repeat(129)],
        ['extra_value_3', 'value-3'],
      ]);
      const html = await resp.text();

      expect(resp.status).toBe(200);
      expect(html).toContain('3 added rows skipped');
      expect(html).not.toContain(SENTINEL_NAME);
      expect(html).not.toContain('lowercase_name');
      expect(html).not.toContain('AAAAAAAA');
      const stored = RequestStore.get(record.id)!;
      expect(stored.results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);
      expect(getSkippedNameCount(stored.results!)).toBe(3);
      expect(storedNames()).toEqual(['OPENAI_API_KEY']);
    });

    it('a single invalid row uses the singular wording', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      const html = await (await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['extra_name_1', SENTINEL_NAME], ['extra_value_1', 'x']])).text();

      expect(html).toContain('1 added row skipped');
    });

    it('a name is validated even when its value is empty (a name with no value is still a name field)', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      const html = await (await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['extra_name_1', SENTINEL_NAME], ['extra_value_1', '']])).text();

      expect(html).toContain('1 added row skipped');
      expect(html).not.toContain(SENTINEL_NAME);
    });

    it('blob keys: invalid keys are counted as DISTINCT names (the same bad key twice counts once) and never echoed', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const blob = ['bad-key=1', 'bad-key=2', 'lowercase=3', 'GOOD_ONE=ok'].join('\n');

      const resp = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', blob]]);
      const html = await resp.text();

      expect(html).toContain('2 invalid names skipped');
      expect(html).not.toContain('bad-key');
      expect(html).not.toContain('lowercase');
      const stored = RequestStore.get(record.id)!;
      expect(stored.results?.map((r) => r.name)).toEqual(['OPENAI_API_KEY', 'GOOD_ONE']);
      expect(getSkippedNameCount(stored.results!)).toBe(2);
    });

    it('a valid-looking name that is over the length cap inside a blob is counted, not stored or echoed', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const longName = 'B'.repeat(200);

      const html = await (await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', `${longName}=v`]])).text();

      expect(html).toContain('1 invalid name skipped');
      expect(html).not.toContain(longName);
      expect(storedNames()).toEqual(['OPENAI_API_KEY']);
    });
  });

  describe('duplicates and ambiguity are refused per name, never guessed', () => {
    it('a name repeated across declared / row / blob is refused with E_VALUE_AMBIGUOUS and nothing is written for it', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      await submit(record.id, [
        ['OPENAI_API_KEY', 'declared-value'],
        ['extra_name_1', 'OPENAI_API_KEY'], // duplicates a declared name
        ['extra_value_1', 'row-value'],
        ['extra_name_2', 'ROW_AND_BLOB'],
        ['extra_value_2', 'row-value'],
        ['extra_name_3', 'ROW_TWICE'],
        ['extra_value_3', 'a'],
        ['extra_name_4', 'ROW_TWICE'], // duplicates another extra row
        ['extra_value_4', 'b'],
        ['dotenv_blob', 'ROW_AND_BLOB=blob-value\nUNIQUE=fine'], // duplicates a row
      ]);

      expect(RequestStore.get(record.id)?.results).toEqual([
        { name: 'OPENAI_API_KEY', ok: false, errorCode: 'E_VALUE_AMBIGUOUS' },
        { name: 'ROW_AND_BLOB', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', addedByUser: true },
        { name: 'ROW_TWICE', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', addedByUser: true },
        { name: 'UNIQUE', ok: true, addedByUser: true },
      ]);
      expect(storedNames()).toEqual(['UNIQUE']);
    });

    it('a name assigned twice inside the blob is refused with parseDotEnv’s own ambiguousReason', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', 'DUP_KEY=val-aaa111\nDUP_KEY=val-bbb222']]);

      const dup = RequestStore.get(record.id)?.results?.find((r) => r.name === 'DUP_KEY');
      expect(dup).toMatchObject({ ok: false, errorCode: 'E_VALUE_AMBIGUOUS', addedByUser: true });
      expect(dup?.reason).toContain('DUP_KEY is assigned more than once');
      expect(dup?.reason).not.toContain('val-aaa111');
      expect(dup?.reason).not.toContain('val-bbb222');
      expect(storedNames()).toEqual(['OPENAI_API_KEY']);
    });

    it('an ambiguous blob line (space before #) is refused with its ambiguousReason, value never stored', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', 'MAYBE_COMMENT=abc123 #not-sure']]);

      const refused = RequestStore.get(record.id)?.results?.find((r) => r.name === 'MAYBE_COMMENT');
      expect(refused).toMatchObject({ ok: false, errorCode: 'E_VALUE_AMBIGUOUS', addedByUser: true });
      expect(refused?.reason).toContain('quote the value');
      expect(refused?.reason).not.toContain('abc123');
      expect(storedNames()).toEqual(['OPENAI_API_KEY']);
    });
  });

  describe('rotate semantics (D1.3)', () => {
    it('an extra name that already exists, without rotate, fails per name with E_EXISTS; the others still store', async () => {
      await setSecret({ name: 'EXISTING_EXTRA', value: 'old', scope: 'global', depository: 'encrypted', actor: 'cli' });
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', 'EXISTING_EXTRA=new\nFRESH_EXTRA=ok']]);

      const results = RequestStore.get(record.id)?.results;
      expect(results?.find((r) => r.name === 'EXISTING_EXTRA')).toMatchObject({ ok: false, errorCode: 'E_EXISTS', addedByUser: true });
      expect(results?.find((r) => r.name === 'FRESH_EXTRA')).toEqual({ name: 'FRESH_EXTRA', ok: true, addedByUser: true });
    });

    it('with rotate checked, an existing extra name is replaced', async () => {
      await setSecret({ name: 'EXISTING_EXTRA', value: 'old', scope: 'global', depository: 'encrypted', actor: 'cli' });
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', 'EXISTING_EXTRA=new']], { rotate: 'on' });

      expect(RequestStore.get(record.id)?.results?.find((r) => r.name === 'EXISTING_EXTRA')).toEqual({
        name: 'EXISTING_EXTRA',
        ok: true,
        addedByUser: true,
      });
    });
  });

  describe('the 25-name cap', () => {
    function rows(count: number): Array<[string, string]> {
      const out: Array<[string, string]> = [];
      for (let i = 1; i <= count; i++) {
        out.push([`extra_name_${i}`, `EXTRA_${i}`], [`extra_value_${i}`, `value-${i}`]);
      }
      return out;
    }

    it('26 total names (1 declared + 25 extra) refuse the whole submission before the id is consumed, and re-render the form with an error', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      const resp = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ...rows(25)]);
      const html = await resp.text();

      expect(resp.status).toBe(400);
      expect(html).toContain('Too many secrets');
      expect(html).toContain('<form');
      expect(html).not.toContain('value-1');
      expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
      expect(RequestStore.get(record.id)?.results).toBeUndefined();
      expect(storedNames()).toEqual([]);
    });

    it('the same id can then be resubmitted within the cap (exactly 25 names) and succeeds', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      await submit(record.id, [['OPENAI_API_KEY', 'v0'], ...rows(25)]);

      const retry = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ...rows(24)]);

      expect(retry.status).toBe(200);
      expect(RequestStore.get(record.id)?.results).toHaveLength(25);
      expect(RequestStore.get(record.id)?.results?.every((r) => r.ok)).toBe(true);
    });

    it('the cap counts blob entries too (declared + rows + blob)', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const blob = Array.from({ length: 25 }, (_, i) => `BLOB_${i + 1}=v`).join('\n');

      const resp = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ['dotenv_blob', blob]]);

      expect(resp.status).toBe(400);
      expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
    });

    it('invalid names do not count toward the cap (they never become results)', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const invalidRows: Array<[string, string]> = [];
      for (let i = 1; i <= 30; i++) invalidRows.push([`extra_name_${i}`, `bad name ${i}`], [`extra_value_${i}`, 'x']);

      const resp = await submit(record.id, [['OPENAI_API_KEY', 'v0'], ...invalidRows]);

      expect(resp.status).toBe(200);
      expect(getSkippedNameCount(RequestStore.get(record.id)!.results!)).toBe(30);
    });
  });

  it('the recovery signal (listUnconsumedFulfilled) names the extras actually stored, refused, and never the invalid ones', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    await submit(record.id, [
      ['OPENAI_API_KEY', 'v0'],
      ['extra_name_1', 'ROW_STORED'],
      ['extra_value_1', 'v1'],
      ['extra_name_2', SENTINEL_NAME],
      ['extra_value_2', 'v2'],
      ['dotenv_blob', 'BLOB_STORED=v3\nDUP=1\nDUP=2'],
    ]);

    const signal = RequestStore.listUnconsumedFulfilled().find((entry) => entry.id === record.id);
    expect(signal).toEqual({
      id: record.id,
      stored: ['OPENAI_API_KEY', 'ROW_STORED', 'BLOB_STORED'],
      failed: ['DUP'],
      unknown: [],
    });
    expect(JSON.stringify(signal)).not.toContain(SENTINEL_NAME);
  });

  it('GET renders the extensible controls: a hidden "+ Add secret" button, a row template, a collapsed .env <details>, and the external script', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const html = await (await fetch(`${origin}/r/${record.id}`)).text();

    expect(html).toMatch(/<button[^>]*id="add-secret"[^>]*hidden/);
    expect(html).toContain('+ Add secret');
    expect(html).toContain('<template id="extra-row-template">');
    expect(html).toMatch(/<details>\s*<summary>Paste a \.env blob<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('name="dotenv_blob"');
    expect(html).toContain('<script src="/static/request-form.js"></script>');
    expect(html).not.toMatch(/<script>[\s\S]*?[^\s][\s\S]*?<\/script>/);
  });
});
