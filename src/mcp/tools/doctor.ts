import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, release } from 'node:os';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadProjectManifest } from '../../core/config.js';
import { EnigmaError } from '../../core/errors.js';
import { readIndex } from '../../core/index-store.js';
import { auditLogPath, configPath, enigmaHome, indexPath, keyPath, secretsPath } from '../../core/paths.js';
import { findProjectPath } from '../../core/project.js';
import { detectAll } from '../../storage/detect.js';
import { listSecrets } from '../../storage/manager.js';
import { supportsFormElicitation, supportsUrlElicitation } from '../elicit.js';
import { textResult } from '../result-text.js';

const execFileAsync = promisify(execFile);

/** Probes for a CLI binary's presence without ever passing it a value. */
async function binaryStatus(command: string, args: string[]): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 2000, maxBuffer: 1024 });
    return { available: true, version: stdout.trim() || null };
  } catch {
    return { available: false, version: null };
  }
}

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    'enigma_doctor',
    {
      title: 'Diagnose the local Enigma setup',
      description:
        'Reports platform, available depositories, the 1Password CLI, tunnel binaries, manifest gaps, config paths, and whether the connected client supports URL-mode elicitation. Never returns a value (ADR-001).',
      inputSchema: {},
    },
    async () => {
      const cwd = process.cwd();
      const [depositoriesRaw, op, cloudflared, tailscale] = await Promise.all([
        detectAll(),
        binaryStatus('op', ['--version']),
        binaryStatus('cloudflared', ['--version']),
        binaryStatus('tailscale', ['version']),
      ]);

      const depositoryLines = depositoriesRaw.map(
        (d) => `  ${d.id}: ${d.available ? 'available' : 'unavailable'} (prompt profile: ${d.promptProfile}${d.reason ? `, ${d.reason}` : ''})`,
      );

      let indexStatus: string;
      try {
        indexStatus = `ok (${readIndex().entries.length} entries)`;
      } catch (err) {
        indexStatus = `ERROR: ${err instanceof EnigmaError ? err.code : 'unknown error'}`;
      }

      const manifest = loadProjectManifest(findProjectPath(cwd));
      const registeredNames = new Set(listSecrets({ scope: 'all', cwd }).map((e) => e.name));
      const manifestGaps = Object.keys(manifest.secrets).filter((name) => !registeredNames.has(name));

      const lines = [
        `Platform: ${platform()} ${release()}`,
        'Depositories:',
        ...depositoryLines,
        `1Password CLI (op): ${op.available ? `available (${op.version ?? 'unknown version'})` : 'not found'}`,
        `cloudflared: ${cloudflared.available ? `available (${cloudflared.version ?? 'unknown version'})` : 'not found'}`,
        `tailscale: ${tailscale.available ? `available (${tailscale.version ?? 'unknown version'})` : 'not found'}`,
        `Client elicitation support: url=${supportsUrlElicitation(server.server)} form=${supportsFormElicitation(server.server)}`,
        `Config home: ${enigmaHome()}`,
        `Index: ${indexStatus}`,
        `Vault key: ${existsSync(keyPath()) ? 'present' : 'missing'}`,
        `Vault file: ${existsSync(secretsPath()) ? 'present' : 'missing'}`,
        `Manifest gaps: ${manifestGaps.length === 0 ? 'none' : manifestGaps.join(', ')}`,
        `Paths: index=${indexPath()} audit=${auditLogPath()} config=${configPath()}`,
      ];

      return textResult(lines.join('\n'));
    },
  );
}
