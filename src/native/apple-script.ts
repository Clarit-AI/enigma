/**
 * Escapes a string for embedding inside a double-quoted AppleScript string
 * literal: backslash and `"` are escaped, and any line break becomes a
 * literal `\n` escape (AppleScript interprets `\n` inside a string literal as
 * a newline; a raw line break would otherwise break the script into two
 * statements). Order matters: backslashes first, so the newline pass's
 * inserted `\n` is not itself re-escaped.
 */
export function escapeAppleScriptString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Builds a `display dialog … with hidden answer` script for one secret name.
 * The last statement returns only `text returned`, so `osascript`'s stdout is
 * exactly the entered value — no `button returned:` wrapper to parse.
 */
export function buildHiddenAnswerScript(name: string, reason: string): string {
  const prompt = reason ? `Enter value for ${name} (${reason}):` : `Enter value for ${name}:`;
  const escapedPrompt = escapeAppleScriptString(prompt);
  return [
    `set dialogResult to display dialog "${escapedPrompt}" default answer "" with hidden answer with title "Enigma"`,
    'return text returned of dialogResult',
  ].join('\n');
}
