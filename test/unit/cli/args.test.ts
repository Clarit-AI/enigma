import { describe, expect, it } from 'vitest';
import { parseArgs, parseScope, parseScopeOrAll, parseUsage, UsageError } from '../../../src/cli/args.js';

describe('parseArgs', () => {
  it('collects positionals and skips no flags', () => {
    expect(parseArgs(['NAME', 'other'])).toEqual({ positionals: ['NAME', 'other'], flags: {} });
  });

  it('reads a value flag as the next argument', () => {
    expect(parseArgs(['NAME', '--scope', 'project'], { value: ['scope'] })).toEqual({
      positionals: ['NAME'],
      flags: { scope: 'project' },
    });
  });

  it('reads a value flag with --flag=value syntax', () => {
    expect(parseArgs(['--scope=global'], { value: ['scope'] })).toEqual({
      positionals: [],
      flags: { scope: 'global' },
    });
  });

  it('reads a boolean flag as present without consuming the next argument', () => {
    expect(parseArgs(['NAME', '--json'], { boolean: ['json'] })).toEqual({
      positionals: ['NAME'],
      flags: { json: true },
    });
  });

  it('throws UsageError for an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
  });

  it('throws UsageError when a value flag has no following argument', () => {
    expect(() => parseArgs(['--scope'], { value: ['scope'] })).toThrow(UsageError);
  });

  // Issue #22, AC #3: a value flag followed by `--something` (the next flag) is a
  // missing-value typo, not a real value. Silently consuming the next flag produces a
  // confusing downstream error; refuse loudly with a usage error instead.
  it('throws UsageError when a value flag is followed by another flag, not a value (Issue #22, AC #3)', () => {
    expect(() => parseArgs(['--description', '--scope', 'global'], { value: ['description', 'scope'] })).toThrow(
      UsageError,
    );
    expect(() => parseArgs(['NAME', '--description', '--scope', 'global'], { value: ['description', 'scope'] })).toThrow(
      /--description requires a value/,
    );
  });

  // Issue #22, AC #4: --json=false must be honored, never silently coerced to true.
  it('honors --flag=false on a boolean flag (Issue #22, AC #4)', () => {
    expect(parseArgs(['NAME', '--json=false'], { boolean: ['json'] })).toEqual({
      positionals: ['NAME'],
      flags: { json: false },
    });
  });

  it('honors --flag=true on a boolean flag (Issue #22, AC #4)', () => {
    expect(parseArgs(['NAME', '--json=true'], { boolean: ['json'] })).toEqual({
      positionals: ['NAME'],
      flags: { json: true },
    });
  });

  it('accepts case-insensitive yes/no/1/0 on boolean flags (Issue #22, AC #4)', () => {
    expect(parseArgs(['--json=YES'], { boolean: ['json'] })).toEqual({ positionals: [], flags: { json: true } });
    expect(parseArgs(['--json=No'], { boolean: ['json'] })).toEqual({ positionals: [], flags: { json: false } });
    expect(parseArgs(['--json=1'], { boolean: ['json'] })).toEqual({ positionals: [], flags: { json: true } });
    expect(parseArgs(['--json=0'], { boolean: ['json'] })).toEqual({ positionals: [], flags: { json: false } });
  });

  it('throws UsageError when a boolean flag has an unparseable =value (Issue #22, AC #4)', () => {
    expect(() => parseArgs(['--json=maybe'], { boolean: ['json'] })).toThrow(UsageError);
    expect(() => parseArgs(['--json=maybe'], { boolean: ['json'] })).toThrow(/expected true or false/);
  });
});

describe('parseScope', () => {
  it('returns undefined when not given', () => {
    expect(parseScope(undefined)).toBeUndefined();
  });

  it('accepts project and global', () => {
    expect(parseScope('project')).toBe('project');
    expect(parseScope('global')).toBe('global');
  });

  it('rejects any other value', () => {
    expect(() => parseScope('all')).toThrow(UsageError);
    expect(() => parseScope(true)).toThrow(UsageError);
  });
});

describe('parseScopeOrAll', () => {
  it('additionally accepts "all"', () => {
    expect(parseScopeOrAll('all')).toBe('all');
  });
});

describe('parseUsage', () => {
  it('accepts interactive and unattended', () => {
    expect(parseUsage('interactive')).toBe('interactive');
    expect(parseUsage('unattended')).toBe('unattended');
  });

  it('rejects any other value', () => {
    expect(() => parseUsage('sometimes')).toThrow(UsageError);
  });
});
