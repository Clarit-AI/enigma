import { describe, expect, it } from 'vitest';
import { parseDotEnv, removeDotEnvEntries } from '../../../src/storage/dotenv-file.js';

describe('parseDotEnv', () => {
  it('parses a simple NAME=value file', () => {
    const result = parseDotEnv('OPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\n');
    expect(result.entries).toEqual([
      { name: 'OPENAI_API_KEY', value: 'sk-abc' },
      { name: 'GITHUB_TOKEN', value: 'ghp-xyz' },
    ]);
    expect(result.invalidNames).toEqual([]);
    expect(result.duplicateNames).toEqual([]);
  });

  it('skips blank lines and comments', () => {
    const result = parseDotEnv('# a comment\n\nOPENAI_API_KEY=sk-abc\n  # indented comment\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc' }]);
  });

  it('strips an "export " prefix, treating it identically to a bare assignment', () => {
    const result = parseDotEnv('export OPENAI_API_KEY=sk-abc\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc' }]);
  });

  it('duplicate key: last value wins, and the name is reported as a duplicate', () => {
    const result = parseDotEnv('OPENAI_API_KEY=first\nOPENAI_API_KEY=second\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'second' }]);
    expect(result.duplicateNames).toEqual(['OPENAI_API_KEY']);
  });

  it('a name that does not match ^[A-Z][A-Z0-9_]*$ is skipped and reported as invalid, not imported', () => {
    const result = parseDotEnv('lower_case=value\nOPENAI_API_KEY=sk-abc\n123_BAD=x\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc' }]);
    expect(result.invalidNames).toEqual(['lower_case', '123_BAD']);
  });

  it('single-line double-quoted value is unwrapped', () => {
    const result = parseDotEnv('MESSAGE="hello world"\n');
    expect(result.entries).toEqual([{ name: 'MESSAGE', value: 'hello world' }]);
  });

  it('single-line single-quoted value is unwrapped', () => {
    const result = parseDotEnv("MESSAGE='hello world'\n");
    expect(result.entries).toEqual([{ name: 'MESSAGE', value: 'hello world' }]);
  });

  it('a multi-line double-quoted value (e.g. a PEM key) parses as one entry', () => {
    const content = 'PRIVATE_KEY="-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----"\nOTHER=1\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([
      { name: 'PRIVATE_KEY', value: '-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----' },
      { name: 'OTHER', value: '1' },
    ]);
  });

  it('ignores entries already inside an existing managed block', () => {
    const content = 'RAW_KEY=plain\n# enigma:begin\nALREADY_MANAGED=x\n# enigma:end\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([{ name: 'RAW_KEY', value: 'plain' }]);
  });

  it('returns no entries for an empty file', () => {
    expect(parseDotEnv('')).toEqual({ entries: [], invalidNames: [], duplicateNames: [] });
  });

  it('malformed input: an unterminated quote does not swallow the rest of the file — later lines still parse independently', () => {
    const content = 'BROKEN="never closed\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([
      { name: 'BROKEN', value: '"never closed' },
      { name: 'OPENAI_API_KEY', value: 'sk-abc' },
      { name: 'GITHUB_TOKEN', value: 'ghp-xyz' },
    ]);
  });
});

describe('removeDotEnvEntries', () => {
  it('removes only the named entries, preserving every other line byte-identical', () => {
    const content = '# header comment\n\nKEEP_ME=1\nOPENAI_API_KEY=sk-abc\nALSO_KEEP=2\n';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
    expect(result).toBe('# header comment\n\nKEEP_ME=1\nALSO_KEEP=2\n');
  });

  it('inserts a single comment at the first removed line when opts.comment is given', () => {
    const content = 'KEEP_ME=1\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\nALSO_KEEP=2\n';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY', 'GITHUB_TOKEN'], { comment: '# moved' });
    expect(result).toBe('KEEP_ME=1\n# moved\nALSO_KEEP=2\n');
  });

  it('removes every occurrence of a duplicated key', () => {
    const content = 'OPENAI_API_KEY=first\nKEEP=1\nOPENAI_API_KEY=second\n';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
    expect(result).toBe('KEEP=1\n');
  });

  it('removes every physical line of a multi-line quoted value as one unit', () => {
    const content = 'KEEP=1\nPRIVATE_KEY="line1\nline2\nline3"\nALSO_KEEP=2\n';
    const result = removeDotEnvEntries(content, ['PRIVATE_KEY']);
    expect(result).toBe('KEEP=1\nALSO_KEEP=2\n');
  });

  it('never touches lines inside the managed block', () => {
    const content = 'RAW=1\n# enigma:begin\nMANAGED=x\n# enigma:end\n';
    const result = removeDotEnvEntries(content, ['RAW', 'MANAGED']);
    expect(result).toBe('# enigma:begin\nMANAGED=x\n# enigma:end\n');
  });

  it('leaves an invalid-name line untouched even if a valid name of the same text were requested', () => {
    const content = 'lower_case=value\nKEEP=1\n';
    const result = removeDotEnvEntries(content, ['lower_case']);
    expect(result).toBe(content);
  });

  it('returns the content unchanged when none of the names are present', () => {
    const content = 'KEEP=1\n';
    expect(removeDotEnvEntries(content, ['NOT_THERE'])).toBe(content);
  });

  it('preserves CRLF line endings', () => {
    const content = 'KEEP=1\r\nOPENAI_API_KEY=sk-abc\r\nALSO_KEEP=2\r\n';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
    expect(result).toBe('KEEP=1\r\nALSO_KEEP=2\r\n');
  });

  it('preserves a missing trailing newline', () => {
    const content = 'KEEP=1\nOPENAI_API_KEY=sk-abc';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
    expect(result).toBe('KEEP=1');
  });

  it('malformed input: removing a name after an unterminated quote never mangles the lines that follow it', () => {
    const content = 'BROKEN="never closed\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\n';
    const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
    expect(result).toBe('BROKEN="never closed\nGITHUB_TOKEN=ghp-xyz\n');
  });
});
