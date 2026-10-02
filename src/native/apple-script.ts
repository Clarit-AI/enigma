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

/** Where one dialog sits in a multi-name request: `index` is 1-based. */
export interface DialogProgress {
  index: number;
  total: number;
}

/**
 * Builds a `display dialog … with hidden answer` script for one secret name.
 * The last statement returns only `text returned`, so `osascript`'s stdout is
 * exactly the entered value — no `button returned:` wrapper to parse.
 *
 * With more than one name (`progress.total > 1`) each dialog says which one
 * it is for ("2 of 3", in the prompt and the title), asks for only that one
 * value, and says the others follow in separate dialogs. The request's single
 * `reason` is shown after that, labelled as covering the whole request, so a
 * reason that describes several credentials cannot make one dialog look like
 * it is asking for all of them (Issue #117). A single name keeps the original,
 * unlabelled wording.
 */
export function buildHiddenAnswerScript(name: string, reason: string, progress?: DialogProgress): string {
  const multi = progress !== undefined && progress.total > 1;
  const prompt = multi
    ? `Enter value for ${name} (${progress.index} of ${progress.total}). Enter only this one value; the other credentials are requested in separate dialogs.${reason ? `\n\nReason for the whole request: ${reason}` : ''}`
    : reason
      ? `Enter value for ${name} (${reason}):`
      : `Enter value for ${name}:`;
  const title = multi ? `Enigma (${progress.index} of ${progress.total})` : 'Enigma';
  const escapedPrompt = escapeAppleScriptString(prompt);
  return [
    `set dialogResult to display dialog "${escapedPrompt}" default answer "" with hidden answer with title "${title}"`,
    'return text returned of dialogResult',
  ].join('\n');
}
