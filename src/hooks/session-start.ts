// SessionStart (D3.3, ADR-004): announces which secret NAMES are available so the
// agent knows to call enigma_request instead of asking the user to paste a value.
// Never a value; never writes CLAUDE_ENV_FILE; every read here is a synchronous
// local file read, so this stays well under the 2 s budget.
import { listSecrets } from '../storage/manager.js';
import { loadConfig, loadProjectManifest } from '../core/config.js';
import { findProjectPath, projectId as computeProjectId } from '../core/project.js';
import type { SessionStartInput, SessionStartOutput } from './types.js';

/**
 * `listSecrets({ scope: 'all' })` returns every entry on this machine, across every
 * project (that's what `enigma list --scope all` wants). SessionStart instead wants
 * only what's relevant here: this project's own entries plus every global entry —
 * so we filter by project id ourselves rather than trusting 'all' to mean "here".
 */
function relevantNames(cwd: string): { names: string[]; declaredSecrets: Record<string, string> } {
  const projectPath = findProjectPath(cwd);
  const pid = computeProjectId(cwd);
  const entries = listSecrets({ scope: 'all', cwd: projectPath }).filter(
    (e) => e.scope === 'global' || e.projectId === pid,
  );
  const names = [...new Set(entries.map((e) => e.name))].sort();
  const manifest = loadProjectManifest(projectPath);
  return { names, declaredSecrets: manifest.secrets };
}

export function runSessionStart(input: SessionStartInput): SessionStartOutput {
  const cwd = input.cwd ?? process.cwd();
  const projectPath = findProjectPath(cwd);
  const { names, declaredSecrets } = relevantNames(cwd);

  const config = loadConfig();
  const manifest = loadProjectManifest(projectPath);
  const stickyDefault = manifest.defaultDepository ?? config.defaultDepository;

  const known = new Set(names);
  const gaps = Object.keys(declaredSecrets)
    .filter((name) => !known.has(name))
    .sort();

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
