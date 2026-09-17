import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DetectionResult } from '../../../src/storage/interfaces.js';

/**
 * `needsCreateVaultConfirmation` calls through to the real 1Password
 * depository's `checkOnepasswordVaultMissing`, which spawns `op` — mocked
 * here at the child_process boundary so this stays a fast, deterministic
 * unit test, never touching a real `op` install (PROJECT_CONTEXT.md
 * sandboxing rules).
 */
type OpRespond = (args: string[]) => { error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null; stdout?: string; stderr?: string };
let respondOp: OpRespond = () => ({ stdout: '' });

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    stdin.write = () => true;
    stdin.end = () => {};
    const result = respondOp(args);
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { buildDepositoryOptions, needsAvailabilityConfirmation, needsCreateVaultConfirmation, pickDefaultDepository } = await import(
  '../../../src/web/depository-picker.js'
);

const DETECTIONS: DetectionResult[] = [
  { id: 'encrypted', promptProfile: 'none', available: true },
  { id: 'env', promptProfile: 'none', available: true },
  { id: 'keychain', promptProfile: 'may-prompt', available: false, reason: 'not on this platform' },
];

describe('pickDefaultDepository', () => {
  it('prefers the sticky default when it is available', () => {
    expect(pickDefaultDepository(DETECTIONS, { sticky: 'env' })).toBe('env');
  });

  it('ignores a sticky default that is unavailable', () => {
    expect(pickDefaultDepository(DETECTIONS, { sticky: 'keychain' })).toBe('encrypted');
  });

  it('prefers a no-prompt depository for unattended usage', () => {
    const detections: DetectionResult[] = [
      { id: 'encrypted', promptProfile: 'none', available: true },
      { id: 'keychain', promptProfile: 'may-prompt', available: true },
    ];
    expect(pickDefaultDepository(detections, { usage: 'unattended' })).toBe('encrypted');
  });

  it('falls back to the first available depository with no sticky default or usage hint', () => {
    expect(pickDefaultDepository(DETECTIONS)).toBe('encrypted');
  });

  it('returns undefined when nothing is available', () => {
    expect(pickDefaultDepository([{ id: 'keychain', promptProfile: 'may-prompt', available: false }])).toBeUndefined();
  });
});

describe('buildDepositoryOptions', () => {
  it('labels each option with its prompt profile', () => {
    const options = buildDepositoryOptions(DETECTIONS);
    expect(options.find((o) => o.id === 'encrypted')?.label).toBe('encrypted (no prompt)');
    expect(options.find((o) => o.id === 'keychain')?.label).toBe('keychain (may prompt)');
  });

  it('marks the requested depository selected over the heuristic', () => {
    const options = buildDepositoryOptions(DETECTIONS, { requested: 'env' });
    expect(options.find((o) => o.id === 'env')?.selected).toBe(true);
    expect(options.find((o) => o.id === 'encrypted')?.selected).toBe(false);
  });

  it('carries the unavailability reason through', () => {
    const options = buildDepositoryOptions(DETECTIONS);
    expect(options.find((o) => o.id === 'keychain')?.reason).toBe('not on this platform');
  });
});

describe('needsAvailabilityConfirmation', () => {
  it('is false for an available, known depository', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, 'encrypted')).toBe(false);
  });

  it('is true for a known but unavailable depository', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, 'keychain')).toBe(true);
  });

  it('is true for a depository id not present in the given detection list at all (e.g. an id the caller passed but detectAll() never reported)', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, '1password')).toBe(true);
  });

  it('is false when no id was given', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, undefined)).toBe(false);
  });
});

describe('needsCreateVaultConfirmation (Issue #28)', () => {
  it('is true for a known but unavailable depository, without ever calling op (short-circuits before the probe)', async () => {
    respondOp = () => {
      throw new Error('op should never be called when the depository is already unavailable');
    };
    await expect(needsCreateVaultConfirmation(DETECTIONS, 'keychain')).resolves.toBe(true);
  });

  it('is false for a non-1password depository that is available (no vault concept applies)', async () => {
    await expect(needsCreateVaultConfirmation(DETECTIONS, 'encrypted')).resolves.toBe(false);
  });

  it('is true for 1password when it is available (per detections) but its vault does not exist', async () => {
    const available: DetectionResult[] = [...DETECTIONS, { id: '1password', promptProfile: 'prompts-each-read', available: true }];
    respondOp = () => ({ error: new Error('op: no such vault'), stderr: '"Enigma" isn\'t a vault in this account' });

    await expect(needsCreateVaultConfirmation(available, '1password')).resolves.toBe(true);
  });

  it('is false for 1password when it is available and its vault already exists', async () => {
    const available: DetectionResult[] = [...DETECTIONS, { id: '1password', promptProfile: 'prompts-each-read', available: true }];
    respondOp = () => ({ stdout: JSON.stringify({ id: 'vaultid', name: 'Enigma' }) });

    await expect(needsCreateVaultConfirmation(available, '1password')).resolves.toBe(false);
  });
});
