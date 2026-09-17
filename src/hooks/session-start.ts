// SessionStart (D3.3, ADR-004): announces which secret NAMES are available so the
// agent knows to call enigma_request instead of asking the user to paste a value.
// Never a value; never writes CLAUDE_ENV_FILE; every read here is a synchronous
// local file read, so this stays well under the 2 s budget.
import { loadConfig, loadProjectManifest } from '../core/config.js';
import { computeManifestGaps } from '../core/manifest-gaps.js';
import { findProjectPath } from '../core/project.js';
import type { SessionStartInput, SessionStartOutput } from './types.js';

export function runSessionStart(input: SessionStartInput): SessionStartOutput {
  const cwd = input.cwd ?? process.cwd();
  const projectPath = findProjectPath(cwd);
  const { registeredNames: names, gaps } = computeManifestGaps(cwd);

  const config = loadConfig();
  const manifest = loadProjectManifest(projectPath);
  const stickyDefault = manifest.defaultDepository ?? config.defaultDepository;

  const lines: string[] = [
    names.length > 0
      ? `Enigma: secrets available for this project (and global): ${names.join(', ')}`
      : 'Enigma: no secrets registered for this project or globally.',
  ];
  if (stickyDefault) lines.push(`Enigma: sticky default depository is "${stickyDefault}".`);
  if (gaps.length > 0) {
    lines.push(
      `Enigma: manifest (.enigma.json) declares ${gaps.join(', ')} but no value is stored yet — call enigma_request to collect them.`,
    );
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };
}
