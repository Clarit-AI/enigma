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
