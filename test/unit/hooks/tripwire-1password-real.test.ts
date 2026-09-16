// Deliberately does NOT mock src/storage/detect.js: this file proves "1password
// is never scanned" against the real DEPOSITORY_MODULES registry (including the
// real onepasswordDepositoryModule registered in Issue #6/#30), not a mock
// stand-in that could pass for the wrong reason. It never actually invokes the
// real depository's set/resolve, so it never needs `op` installed or signed in.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTripwire } from '../../../src/hooks/tripwire.js';
import { DEPOSITORY_MODULES } from '../../../src/storage/detect.js';
import { indexPath, configPath } from '../../../src/core/paths.js';
import type { IndexEntry, IndexFile } from '../../../src/core/index-store.js';

describe('PostToolUse tripwire vs. the real 1password module', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;

    const onePasswordModule = DEPOSITORY_MODULES.find((m) => m.id === '1password');
    if (!onePasswordModule) {
      throw new Error('expected the real 1password module to be registered in DEPOSITORY_MODULES (Issue #6/#30)');
    }
    createSpy = vi.spyOn(onePasswordModule, 'create');
  });

  afterEach(() => {
    createSpy.mockRestore();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('never calls the real 1password depository\'s create(), even when config explicitly lists it', async () => {
    writeFileSync(configPath(), JSON.stringify({ tripwire: { depositories: ['1password'] } }));

    const entry: IndexEntry = {
      name: 'OP_SECRET',
      scope: 'global',
      depository: '1password',
      ref: 'some-real-item-id',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const index: IndexFile = { version: 1, entries: [entry] };
    writeFileSync(indexPath(), JSON.stringify(index));

    const result = await runTripwire({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'this text is irrelevant — 1password must never even be asked, let alone matched',
      cwd: tmpHome,
    });

    expect(result).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
