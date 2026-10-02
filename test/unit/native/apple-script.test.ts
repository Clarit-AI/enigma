import { describe, expect, it } from 'vitest';
import { buildHiddenAnswerScript, escapeAppleScriptString } from '../../../src/native/apple-script.js';

describe('escapeAppleScriptString', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeAppleScriptString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('escapes newlines and CRLF to the AppleScript \\n sequence', () => {
    expect(escapeAppleScriptString('line1\nline2')).toBe('line1\\nline2');
    expect(escapeAppleScriptString('line1\r\nline2')).toBe('line1\\nline2');
    expect(escapeAppleScriptString('line1\rline2')).toBe('line1\\nline2');
  });

  it('escapes backslashes before turning a newline into \\n, so nothing double-escapes', () => {
    const result = escapeAppleScriptString('a\\\nb');
    expect(result).not.toMatch(/[\r\n]/);
    // original backslash doubles to 2, plus the newline's own escape backslash = 3
    expect(result.match(/\\/g)).toHaveLength(3);
    expect(result.endsWith('nb')).toBe(true);
  });

  it('leaves an already-safe string unchanged', () => {
    expect(escapeAppleScriptString('OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
  });
});

describe('buildHiddenAnswerScript', () => {
  it('uses "with hidden answer" and an empty default answer', () => {
    const script = buildHiddenAnswerScript('OPENAI_API_KEY', 'testing');
    expect(script).toContain('with hidden answer');
    expect(script).toContain('default answer ""');
  });

  it('extracts only the text returned, avoiding the "button returned:" wrapper', () => {
    const script = buildHiddenAnswerScript('OPENAI_API_KEY', 'testing');
    expect(script).toContain('return text returned of dialogResult');
  });

  it('includes the name and reason in the prompt', () => {
    const script = buildHiddenAnswerScript('OPENAI_API_KEY', 'deploying to prod');
    expect(script).toContain('OPENAI_API_KEY');
    expect(script).toContain('deploying to prod');
  });

  it('omits the parenthetical when reason is empty', () => {
    const script = buildHiddenAnswerScript('OPENAI_API_KEY', '');
    expect(script).toContain('Enter value for OPENAI_API_KEY:');
    expect(script).not.toContain('()');
  });

  it('escapes a name containing a double quote and a backslash so the literal stays well-formed', () => {
    const hostileName = 'FOO" & (do shell script "touch pwned") & "BAR\\';
    const script = buildHiddenAnswerScript(hostileName, 'reason');
    const expectedEscapedPrompt = escapeAppleScriptString(`Enter value for ${hostileName} (reason):`);
    expect(script).toContain(`display dialog "${expectedEscapedPrompt}" default answer ""`);
    // the raw hostile name must never appear verbatim next to an unescaped quote
    expect(script).not.toContain('FOO" &');
  });

  it('escapes a reason containing a double quote and a backslash', () => {
    const hostileReason = 'say "hi" \\ done';
    const script = buildHiddenAnswerScript('NAME', hostileReason);
    const expectedEscapedPrompt = escapeAppleScriptString(`Enter value for NAME (${hostileReason}):`);
    expect(script).toContain(`display dialog "${expectedEscapedPrompt}" default answer ""`);
  });

  it('produces exactly two statements: the dialog call and the text-returned extraction', () => {
    const script = buildHiddenAnswerScript('NAME', 'reason');
    expect(script.split('\n')).toHaveLength(2);
  });
});

describe('buildHiddenAnswerScript with several names (Issue #117)', () => {
  const REASON = 'R2 API token scoped to bucket b. R2_ENDPOINT is the https://<account-id>.r2.cloudflarestorage.com URL.';

  it('names the credential and its position in the prompt and in the title', () => {
    const script = buildHiddenAnswerScript('R2_ACCESS_KEY_ID', REASON, { index: 1, total: 3 });
    expect(script).toContain('Enter value for R2_ACCESS_KEY_ID (1 of 3).');
    expect(script).toContain('with title "Enigma (1 of 3)"');
  });

  it('asks for only that one value and says the others follow in separate dialogs', () => {
    const script = buildHiddenAnswerScript('R2_ACCESS_KEY_ID', REASON, { index: 1, total: 3 });
    expect(script).toContain('Enter only this one value; the other credentials are requested in separate dialogs.');
  });

  it('shows the shared reason after the name, labelled as covering the whole request, so it cannot read as this dialog asking for several values', () => {
    const script = buildHiddenAnswerScript('R2_ACCESS_KEY_ID', REASON, { index: 2, total: 3 });
    expect(script.indexOf('Enter value for R2_ACCESS_KEY_ID (2 of 3)')).toBeLessThan(script.indexOf('Reason for the whole request:'));
    expect(script).toContain(`Reason for the whole request: ${REASON}`);
    // not the old single-name shape that put the whole reason in parentheses right after the name
    expect(script).not.toContain(`Enter value for R2_ACCESS_KEY_ID (${REASON}`);
  });

  it('omits the reason section when the reason is empty', () => {
    const script = buildHiddenAnswerScript('A', '', { index: 1, total: 2 });
    expect(script).not.toContain('Reason for the whole request');
  });

  it('a single name (total 1, or no progress) keeps the original unlabelled wording and title', () => {
    expect(buildHiddenAnswerScript('A', 'why', { index: 1, total: 1 })).toBe(buildHiddenAnswerScript('A', 'why'));
    expect(buildHiddenAnswerScript('A', 'why')).toContain('Enter value for A (why):');
    expect(buildHiddenAnswerScript('A', 'why')).toContain('with title "Enigma"');
  });

  it('escapes a hostile name and reason in the multi-name prompt, and still produces exactly two statements', () => {
    const hostileName = 'FOO" & (do shell script "touch pwned") & "BAR\\';
    const script = buildHiddenAnswerScript(hostileName, 'say "hi" \\ done\nline2', { index: 2, total: 3 });
    expect(script).not.toContain('FOO" &');
    expect(script).not.toContain('say "hi"');
    expect(script.split('\n')).toHaveLength(2);
  });
});

