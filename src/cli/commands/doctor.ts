import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, release } from 'node:os';
import { promisify } from 'node:util';
import { parseArgs } from '../args.js';
import { detectAll } from '../../storage/detect.js';
import { readIndex } from '../../core/index-store.js';
import { auditLogPath, configPath, enigmaHome, indexPath, keyPath, secretsPath } from '../../core/paths.js';
import { EnigmaError } from '../../core/errors.js';

const execFileAsync = promisify(execFile);

/** Probes for the 1Password CLI (`op`) without ever passing it a value. */
async function opStatus(): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync('op', ['--version'], { timeout: 2000, maxBuffer: 1024 });
    return { available: true, version: stdout.trim() || null };
  } catch {
    return { available: false, version: null };
  }
}

export async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { boolean: ['json'] });
  const json = Boolean(flags.json);

  const [depositoriesRaw, op] = await Promise.all([detectAll(), opStatus()]);
  const depositories = depositoriesRaw.map((d) => ({
    id: d.id,
    available: d.available,
    promptProfile: d.promptProfile,
    reason: d.reason ?? null,
  }));

  let index: { ok: boolean; entries?: number; error?: string };
  try {
    index = { ok: true, entries: readIndex().entries.length };
  } catch (err) {
    index = { ok: false, error: err instanceof EnigmaError ? err.code : 'unknown error' };
  }

  const vault = {
    keyPresent: existsSync(keyPath()),
    secretsFilePresent: existsSync(secretsPath()),
  };

  const report = {
    platform: `${platform()} ${release()}`,
    depositories,
    op,
    config: {
      home: enigmaHome(),
      indexPath: indexPath(),
      auditLogPath: auditLogPath(),
      configPath: configPath(),
      keyPath: keyPath(),
      secretsPath: secretsPath(),
    },
    index,
    vault,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  const lines = [
    `Platform: ${report.platform}`,
    'Depositories:',
    ...depositories.map(
      (d) => `  ${d.id}: ${d.available ? 'available' : 'unavailable'} (prompt profile: ${d.promptProfile}${d.reason ? `, ${d.reason}` : ''})`,
    ),
    `1Password CLI (op): ${op.available ? `available (${op.version ?? 'unknown version'})` : 'not found'}`,
    `Config home: ${report.config.home}`,
    `Index: ${index.ok ? `ok (${index.entries} entries)` : `ERROR: ${index.error}`}`,
    `Vault key: ${vault.keyPresent ? 'present' : 'missing'}`,
    `Vault file: ${vault.secretsFilePresent ? 'present' : 'missing'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
