import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, release } from 'node:os';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnigmaError } from '../../core/errors.js';
import { readIndex } from '../../core/index-store.js';
import { computeManifestGaps } from '../../core/manifest-gaps.js';
import { auditLogPath, configPath, enigmaHome, indexPath, keyPath, secretsPath } from '../../core/paths.js';
import { RequestStore } from '../../request/store.js';
import { detectAll } from '../../storage/detect.js';
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

      const { gaps: manifestGaps } = computeManifestGaps(cwd);

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

      // Issue #62 + #68 + #40: a request/import whose form was already
      // submitted (the web layer stored the secret independently of this
      // tool call) but whose outcome no enigma_await/enigma_request/
      // enigma_import call has ever returned to the model — e.g. the
      // original blocking call was interrupted before the user
      // submitted. Names and ids only, never values, per-name
      // `errorCode`, or `reason` text (ADR-001). The buckets mirror
      // `renderOutcome`'s three-way split in `src/mcp/result-text.ts`:
      //   - "stored: …"        — the per-name write succeeded
      //   - "failed: …"        — the per-name write was a confirmed refusal
      //   - "outcome unknown: …" — the per-name write's outcome is unknown
      //                            (commitImport crashed; the name MAY
      //                            already be stored, the agent must check
      //                            before retrying — this is the Issue #40
      //                            distinction: an unknown outcome is not
      //                            a confirmed failure, the word "failed"
      //                            is never used for it).
      // The store reads `errorCode` only to choose the bucket; it never
      // appears in the rendered text. Omitted entirely when there is
      // nothing pending, matching every other line above that only
      // reports when there's something to report. Records whose `results`
      // is empty (or whose bucketed lists are all empty) are skipped at
      // the store layer (nothing to re-await).
      const pendingRequests = RequestStore.listUnconsumedFulfilled();
      if (pendingRequests.length > 0) {
        lines.push(
          'Pending unconfirmed requests:',
          ...pendingRequests.map((r) => {
            const parts: string[] = [];
            if (r.stored.length > 0) parts.push(`stored: ${r.stored.join(', ')}`);
            if (r.failed.length > 0) parts.push(`failed: ${r.failed.join(', ')}`);
            if (r.unknown.length > 0) parts.push(`outcome unknown: ${r.unknown.join(', ')}`);
            return `  ${r.id} (${parts.join('; ')}) — call enigma_await(${r.id})`;
          }),
        );
      }

      return textResult(lines.join('\n'));
    },
  );
}
