import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditEvent, auditErrorText } from '../../src/core/audit.js';
import type { AuditEvent } from '../../src/core/audit.js';
import { auditLogPath } from '../../src/core/paths.js';
import { EnigmaError } from '../../src/core/errors.js';

describe('appendAuditEvent', () => {
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

  it('appends a JSONL line at mode 0600 with a ts field', () => {
    appendAuditEvent({ op: 'set', name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null });

    const mode = statSync(auditLogPath()).mode & 0o777;
    expect(mode).toBe(0o600);

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({ op: 'set', name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null });
    expect(typeof parsed.ts).toBe('string');
  });

  it('appends multiple events as separate lines', () => {
    appendAuditEvent({ op: 'set', name: 'A', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null });
    appendAuditEvent({ op: 'remove', name: 'A', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('the AuditEvent type has no value field (compile-time)', () => {
    // @ts-expect-error — a `value` key must never be assignable into an audit event.
    const event: AuditEvent = { op: 'set', name: 'A', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null, value: 'sk-sentinel' };
    void event;
  });

  it('method is optional and defaults to absent for a non-reveal op (Issue #26)', () => {
    appendAuditEvent({ op: 'set', name: 'A', scope: 'global', depository: 'encrypted', actor: 'cli', ok: true, error: null });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect('method' in parsed).toBe(false);
  });

  it('records a reveal disclosure method and never any value-shaped data in it (Issue #26)', () => {
    const SENTINEL = 'sk-sentinel-value-should-never-appear';
    appendAuditEvent({ op: 'reveal', name: 'A', scope: 'global', depository: 'encrypted', actor: 'user', ok: true, error: null, method: 'clipboard' });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.method).toBe('clipboard');
    // The union only ever names a disclosure surface — assert the exact members allowed,
    // so a future edit widening it to a free string (and thus able to smuggle a value or
    // ref) fails this test rather than failing silently.
    expect(['clipboard', 'page', 'native-dialog']).toContain(parsed.method);
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });

  it('the AuditRevealMethod union rejects an arbitrary string (compile-time)', () => {
    // @ts-expect-error — method must be one of the union's literal members, never a free string.
    const event: AuditEvent = { op: 'reveal', name: 'A', scope: 'global', depository: 'encrypted', actor: 'user', ok: true, error: null, method: 'sk-sentinel-value' };
    void event;
  });
});

describe('auditErrorText', () => {
  it('renders an EnigmaError as "CODE: message"', () => {
    const err = new EnigmaError({ code: 'E_READ_FAILED', message: 'failed to read secret', depository: 'encrypted' });
    expect(auditErrorText(err)).toBe('E_READ_FAILED: failed to read secret');
  });

  it('renders any other Error as only its constructor name, never its message', () => {
    const err = new TypeError('leaked sk-sentinel-value');
    expect(auditErrorText(err)).toBe('TypeError');
  });

  it('renders a non-Error thrown value as UnknownError', () => {
    expect(auditErrorText('sk-sentinel-value')).toBe('UnknownError');
  });
});
