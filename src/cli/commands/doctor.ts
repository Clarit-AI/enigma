import { existsSync } from 'node:fs';
import { platform, release } from 'node:os';
import { parseArgs } from '../args.js';
import { detectAll } from '../../storage/detect.js';
import { readIndex } from '../../core/index-store.js';
import { auditLogPath, configPath, enigmaHome, indexPath, keyPath, secretsPath } from '../../core/paths.js';
import { EnigmaError } from '../../core/errors.js';

export async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { boolean: ['json'] });
  const json = Boolean(flags.json);

  const depositories = (await detectAll()).map((d) => ({
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
    `Config home: ${report.config.home}`,
    `Index: ${index.ok ? `ok (${index.entries} entries)` : `ERROR: ${index.error}`}`,
    `Vault key: ${vault.keyPresent ? 'present' : 'missing'}`,
    `Vault file: ${vault.secretsFilePresent ? 'present' : 'missing'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
