import { describe, expect, it } from 'vitest';
import {
  buildDepositoryOptions,
  needsAvailabilityConfirmation,
  pickDefaultDepository,
} from '../../../src/web/depository-picker.js';
import type { DetectionResult } from '../../../src/storage/interfaces.js';

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

  it('is true for a depository not present in the detection list at all (e.g. 1password before Issue #6 lands)', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, '1password')).toBe(true);
  });

  it('is false when no id was given', () => {
    expect(needsAvailabilityConfirmation(DETECTIONS, undefined)).toBe(false);
  });
});
