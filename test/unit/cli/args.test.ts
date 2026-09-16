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
