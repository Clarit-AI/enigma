import { describe, expect, it } from 'vitest';
import { parseDotEnv, removeDotEnvEntries, scanRenderMarkers } from '../../../src/storage/dotenv-file.js';
import { ENV_BEGIN_MARKER, ENV_END_MARKER, RENDER_BEGIN_MARKER, RENDER_END_MARKER } from '../../../src/storage/dotenv-file.js';

describe('parseDotEnv', () => {
  it('parses a simple NAME=value file', () => {
    const result = parseDotEnv('OPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\n');
    expect(result.entries).toEqual([
      { name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false },
      { name: 'GITHUB_TOKEN', value: 'ghp-xyz', ambiguous: false },
    ]);
    expect(result.invalidNames).toEqual([]);
    expect(result.duplicateNames).toEqual([]);
  });

  it('skips blank lines and comments', () => {
    const result = parseDotEnv('# a comment\n\nOPENAI_API_KEY=sk-abc\n  # indented comment\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false }]);
  });

  it('strips an "export " prefix, treating it identically to a bare assignment', () => {
    const result = parseDotEnv('export OPENAI_API_KEY=sk-abc\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false }]);
  });

  it('duplicate key: reported as a duplicate AND flagged ambiguous (Issue #13 review, round 3, item 1) — neither occurrence is silently chosen', () => {
    const result = parseDotEnv('OPENAI_API_KEY=first\nOPENAI_API_KEY=second\n');
    expect(result.entries).toEqual([
      {
        name: 'OPENAI_API_KEY',
        value: 'second',
        ambiguous: true,
        ambiguousReason: expect.stringContaining('assigned more than once'),
      },
    ]);
    expect(result.duplicateNames).toEqual(['OPENAI_API_KEY']);
  });

  it('a name that does not match ^[A-Z][A-Z0-9_]*$ is skipped and reported as invalid, not imported', () => {
    const result = parseDotEnv('lower_case=value\nOPENAI_API_KEY=sk-abc\n123_BAD=x\n');
    expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false }]);
    expect(result.invalidNames).toEqual(['lower_case', '123_BAD']);
  });

  it('single-line double-quoted value is unwrapped', () => {
    const result = parseDotEnv('MESSAGE="hello world"\n');
    expect(result.entries).toEqual([{ name: 'MESSAGE', value: 'hello world', ambiguous: false }]);
  });

  it('single-line single-quoted value is unwrapped', () => {
    const result = parseDotEnv("MESSAGE='hello world'\n");
    expect(result.entries).toEqual([{ name: 'MESSAGE', value: 'hello world', ambiguous: false }]);
  });

  it('a multi-line double-quoted value (e.g. a PEM key) parses as one entry', () => {
    const content = 'PRIVATE_KEY="-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----"\nOTHER=1\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([
      { name: 'PRIVATE_KEY', value: '-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----', ambiguous: false },
      { name: 'OTHER', value: '1', ambiguous: false },
    ]);
  });

  it('ignores entries already inside an existing managed block', () => {
    const content = 'RAW_KEY=plain\n# enigma:begin\nALREADY_MANAGED=x\n# enigma:end\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([{ name: 'RAW_KEY', value: 'plain', ambiguous: false }]);
  });

  it('returns no entries for an empty file', () => {
    expect(parseDotEnv('')).toEqual({ entries: [], invalidNames: [], duplicateNames: [] });
  });

  it('malformed input: an unterminated quote does not swallow the rest of the file — later lines still parse independently', () => {
    const content = 'BROKEN="never closed\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\n';
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([
      { name: 'BROKEN', value: '"never closed', ambiguous: false },
      { name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false },
      { name: 'GITHUB_TOKEN', value: 'ghp-xyz', ambiguous: false },
    ]);
  });

  describe('ambiguous inline-comment-like values (Issue #13 review, round 2, A2)', () => {
    it('an unquoted value with " #" is flagged ambiguous, refusing to guess whether it is a comment or part of the secret', () => {
      const result = parseDotEnv('PORT=3000 # dev port\n');
      expect(result.entries).toEqual([
        { name: 'PORT', value: '3000 # dev port', ambiguous: true, ambiguousReason: expect.stringContaining('quote the value') },
      ]);
    });

    it('a passphrase-shaped value with " #" is flagged ambiguous too, rather than being silently truncated', () => {
      const result = parseDotEnv('PASSPHRASE=hunter2 #1\n');
      expect(result.entries).toEqual([
        { name: 'PASSPHRASE', value: 'hunter2 #1', ambiguous: true, ambiguousReason: expect.stringContaining('quote the value') },
      ]);
    });

    it('a quoted value containing "#" is never ambiguous, whatever it contains', () => {
      const result = parseDotEnv('TOKEN="abc#def"\n');
      expect(result.entries).toEqual([{ name: 'TOKEN', value: 'abc#def', ambiguous: false }]);
    });

    it('a quoted value containing " #" (space then hash) is still unambiguous — the quote already delimits it', () => {
      const result = parseDotEnv('TOKEN="abc # def"\n');
      expect(result.entries).toEqual([{ name: 'TOKEN', value: 'abc # def', ambiguous: false }]);
    });

    it('a plain unquoted value with no "#" at all is unaffected', () => {
      const result = parseDotEnv('OPENAI_API_KEY=sk-abc\n');
      expect(result.entries).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-abc', ambiguous: false }]);
    });

    it('a "#" with no preceding space is not treated as ambiguous (no plausible comment reading)', () => {
      const result = parseDotEnv('TOKEN=abc#def\n');
      expect(result.entries).toEqual([{ name: 'TOKEN', value: 'abc#def', ambiguous: false }]);
    });

    it('a duplicated name is ambiguous on the duplicate-key trigger even before considering its value', () => {
      const result = parseDotEnv('PORT=3000\nPORT=8080 # overridden\n');
      expect(result.entries).toEqual([
        { name: 'PORT', value: '8080 # overridden', ambiguous: true, ambiguousReason: expect.stringContaining('assigned more than once') },
      ]);
    });
  });

  describe('duplicate keys (Issue #13 review, round 3, item 1)', () => {
    it('a duplicated key with two DIFFERENT values is flagged ambiguous — neither the first (never migrated) nor the last is silently chosen', () => {
      const content = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
      const result = parseDotEnv(content);
      expect(result.entries).toEqual([
        {
          name: 'API_KEY',
          value: 'placeholder',
          ambiguous: true,
          ambiguousReason: expect.stringContaining('assigned more than once'),
        },
      ]);
      expect(result.duplicateNames).toEqual(['API_KEY']);
    });

    it('three or more occurrences of the same name are still just one ambiguous entry', () => {
      const result = parseDotEnv('KEY=a\nKEY=b\nKEY=c\n');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.ambiguous).toBe(true);
      expect(result.duplicateNames).toEqual(['KEY']);
    });
  });

  describe('ambiguousReason never carries a value (Issue #13 review, round 4, finding 2)', () => {
    const SENTINEL = 'sk-sentinel-value-should-never-appear';

    it('the inline-comment reason is static text, never the value that triggered it', () => {
      const result = parseDotEnv(`SECRET=${SENTINEL} # trailing\n`);
      const reason = result.entries.find((e) => e.name === 'SECRET')?.ambiguousReason;
      expect(reason).toBeDefined();
      expect(reason).not.toContain(SENTINEL);
    });

    it('the duplicate-key reason names only the key, never either of its values', () => {
      const result = parseDotEnv(`SECRET=${SENTINEL}-first\nSECRET=${SENTINEL}-second\n`);
      const reason = result.entries.find((e) => e.name === 'SECRET')?.ambiguousReason;
      expect(reason).toBeDefined();
      expect(reason).toContain('SECRET');
      expect(reason).not.toContain(SENTINEL);
    });
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

  it(
    'a low-level, "do what it\'s told" primitive: given an explicit name, it removes every physical occurrence, ' +
      'with no awareness of duplication or migration safety. This is NOT how the product handles a duplicated ' +
      'key in real use — parseDotEnv flags a duplicated name ambiguous and commitImport refuses it before this ' +
      'function is ever asked to remove it for that reason (Issue #13 review, round 3, item 1: an earlier version ' +
      "of this test asserted duplicate-key removal as the product's real behavior, which was itself the defect).",
    () => {
      const content = 'OPENAI_API_KEY=first\nKEEP=1\nOPENAI_API_KEY=second\n';
      const result = removeDotEnvEntries(content, ['OPENAI_API_KEY']);
      expect(result).toBe('KEEP=1\n');
    },
  );

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

describe('parseDotEnv / removeDotEnvEntries — both managed blocks (env + render) are skipped, in either order (Issue #107)', () => {
  it('parseDotEnv: a render block in either order is skipped — its lines are not imported', () => {
    const envFirst = `RAW=plain\n${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n`;
    const renderFirst = `RAW=plain\n${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n`;

    for (const content of [envFirst, renderFirst]) {
      const result = parseDotEnv(content);
      expect(result.entries.map((e) => e.name)).toEqual(['RAW']);
    }
  });

  it('removeDotEnvEntries: with both blocks present, a raw-line name is removed; both blocks stay byte-identical (Tech Lead rule #6)', () => {
    const content =
      `RAW=plain\n${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n`;
    const result = removeDotEnvEntries(content, ['RAW']);
    expect(result).toBe(
      `${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n`,
    );
  });

  it('removeDotEnvEntries: a name in the render block is not removed by import (it lives in a different store and is read-only there)', () => {
    const content =
      `RAW=plain\n${RENDER_BEGIN_MARKER}\nRENDERED=in-render-block\n${RENDER_END_MARKER}\n`;
    const result = removeDotEnvEntries(content, ['RENDERED']);
    // The scanner never saw RENDERED (it was in a managed block) so
    // nothing is removed. The whole file is unchanged.
    expect(result).toBe(content);
  });

  it('removeDotEnvEntries: render block appearing before the env block is also preserved (either order)', () => {
    const content =
      `RAW=plain\n${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n`;
    const result = removeDotEnvEntries(content, ['RAW']);
    expect(result).toBe(
      `${RENDER_BEGIN_MARKER}\nR=render-block-name\n${RENDER_END_MARKER}\n${ENV_BEGIN_MARKER}\nE=env-block-name\n${ENV_END_MARKER}\n`,
    );
  });

  it('parseDotEnv: a render block does not leak a value it carries as a parseDotEnv entry', () => {
    const SENTINEL = 'sk-sentinel-value-should-never-appear';
    const content = `RAW=plain\n${RENDER_BEGIN_MARKER}\nRENDERED=${SENTINEL}\n${RENDER_END_MARKER}\n`;
    const result = parseDotEnv(content);
    expect(result.entries).toEqual([{ name: 'RAW', value: 'plain', ambiguous: false }]);
    // Sentinel never surfaces.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('[r3.3] an unterminated render block runs to EOF and is never imported or stripped', () => {
  const damaged = `A=1\n${RENDER_BEGIN_MARKER}\nB=2\nC=3\n`;

  it('parseDotEnv imports nothing from it', () => {
    expect(parseDotEnv(damaged).entries.map((e) => e.name)).toEqual(['A']);
  });

  it('parseDotEnv also skips a render block whose end marker has text glued on', () => {
    const glued = `A=1\n${RENDER_BEGIN_MARKER}\nB=2\n${RENDER_END_MARKER}D=4\n`;
    expect(parseDotEnv(glued).entries.map((e) => e.name)).toEqual(['A']);
  });

  it('removeDotEnvEntries leaves every line of it in place', () => {
    expect(removeDotEnvEntries(damaged, ['A', 'B', 'C'])).toBe(`${RENDER_BEGIN_MARKER}\nB=2\nC=3\n`);
  });

  it('a terminated render block followed by ordinary lines is unaffected (both still parsed and skipped as before)', () => {
    const ok = `${RENDER_BEGIN_MARKER}\nB=2\n${RENDER_END_MARKER}\nD=4\n`;
    expect(parseDotEnv(ok).entries.map((e) => e.name)).toEqual(['D']);
  });

  it('the env depository block keeps its own handling: an unterminated one is not a block, so its lines are ordinary assignments', () => {
    const envDamaged = `${ENV_BEGIN_MARKER}\nB=2\n`;
    expect(parseDotEnv(envDamaged).entries.map((e) => e.name)).toEqual(['B']);
  });
});

describe('[r4.2] every render marker is scanned: complete blocks and everything after the first unterminated begin are protected', () => {
  const names = (content: string): string[] => parseDotEnv(content).entries.map((e) => e.name);

  it('a valid block followed by a second unterminated begin: neither block\'s assignments are imported', () => {
    const content = `A=1\n${RENDER_BEGIN_MARKER}\nR=old\n${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\nB=old\n`;
    expect(names(content)).toEqual(['A']);
  });

  it('a valid block followed by a second unterminated begin: removal strips only the ordinary line, keeping R and B', () => {
    const content = `A=1\n${RENDER_BEGIN_MARKER}\nR=old\n${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\nB=old\n`;
    expect(removeDotEnvEntries(content, ['A', 'R', 'B'])).toBe(`${RENDER_BEGIN_MARKER}\nR=old\n${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\nB=old\n`);
  });

  it('two complete render blocks are both protected', () => {
    const content = `${RENDER_BEGIN_MARKER}\nR1=x\n${RENDER_END_MARKER}\nX=1\n${RENDER_BEGIN_MARKER}\nR2=y\n${RENDER_END_MARKER}\n`;
    expect(names(content)).toEqual(['X']);
    expect(removeDotEnvEntries(content, ['R1', 'R2', 'X'])).toBe(`${RENDER_BEGIN_MARKER}\nR1=x\n${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\nR2=y\n${RENDER_END_MARKER}\n`);
  });

  it('a stray end marker protects nothing and does not hide the ordinary lines around it', () => {
    const content = `A=1\n${RENDER_END_MARKER}\nB=2\n`;
    expect(names(content)).toEqual(['A', 'B']);
  });

  it('a stray end marker before a complete block does not stop that block being protected', () => {
    const content = `${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\nR=old\n${RENDER_END_MARKER}\nX=1\n`;
    expect(names(content)).toEqual(['X']);
  });

  it('a nested begin inside a block keeps the whole block protected', () => {
    const content = `${RENDER_BEGIN_MARKER}\nA=1\n${RENDER_BEGIN_MARKER}\nB=1\n${RENDER_END_MARKER}\nX=2\n`;
    expect(names(content)).toEqual(['X']);
  });

  it('scanRenderMarkers reports damage for each failing shape and none for zero or one well-formed block', () => {
    const lines = (s: string): string[] => s.split('\n');
    expect(scanRenderMarkers(lines('A=1\n')).damaged).toBe(false);
    expect(scanRenderMarkers(lines(`${RENDER_BEGIN_MARKER}\nA=1\n${RENDER_END_MARKER}\n`)).damaged).toBe(false);
    expect(scanRenderMarkers(lines(`${RENDER_BEGIN_MARKER}\nA=1\n`)).damaged).toBe(true);
    expect(scanRenderMarkers(lines(`${RENDER_END_MARKER}\n`)).damaged).toBe(true);
    expect(scanRenderMarkers(lines(`${RENDER_BEGIN_MARKER}\n${RENDER_END_MARKER}\n${RENDER_BEGIN_MARKER}\n${RENDER_END_MARKER}\n`)).damaged).toBe(true);
    expect(scanRenderMarkers(lines(`${RENDER_BEGIN_MARKER}\n${RENDER_BEGIN_MARKER}\n${RENDER_END_MARKER}\n`)).damaged).toBe(true);
  });
});
