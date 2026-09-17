// Single source of truth for "which secrets does this project's .enigma.json
// declare that aren't actually available here" — used by CLI doctor, MCP
// doctor, and the SessionStart hook (Issue #13 review, round 2: three
// independent forks of this filter is the same defect ClawVault was
// harvested away from, only smaller). Names only, never a value.
import { loadProjectManifest } from './config.js';
import { findProjectPath, projectId as computeProjectId } from './project.js';
import { listSecrets } from '../storage/manager.js';

export interface ManifestGapsResult {
  /** Names actually available here: this project's own entries plus every global entry — never another project's same-named secret. */
  registeredNames: string[];
  /** Manifest-declared names with no stored value available here, sorted. */
  gaps: string[];
}

/**
 * `listSecrets({ scope: 'all' })` returns every entry on this machine, across
 * every project — appropriate for `enigma list --scope all`, wrong here: a
 * same-named secret in an unrelated project must never mask a genuine gap in
 * THIS one. Filters to this project's id (or global) before comparing
 * against the manifest.
 */
export function computeManifestGaps(cwd: string): ManifestGapsResult {
  const projectPath = findProjectPath(cwd);
  const pid = computeProjectId(cwd);
  const entries = listSecrets({ scope: 'all', cwd: projectPath }).filter(
    (e) => e.scope === 'global' || e.projectId === pid,
  );
  const registeredNames = [...new Set(entries.map((e) => e.name))].sort();

  const manifest = loadProjectManifest(projectPath);
  const known = new Set(registeredNames);
  const gaps = Object.keys(manifest.secrets)
    .filter((name) => !known.has(name))
    .sort();

  return { registeredNames, gaps };
}
