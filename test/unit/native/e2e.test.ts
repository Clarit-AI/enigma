import { describe, expect, it } from 'vitest';

// Opt-in only (ENIGMA_E2E=1): exercises the real osascript/pbcopy/pbpaste
// binaries via execWithStdin. None of this opens a visible dialog (no
// `display dialog` is run), so it never steals focus even when it does run.
// This file intentionally does not mock `node:child_process`.
describe.skipIf(process.env.ENIGMA_E2E !== '1')('native adapters E2E (real macOS binaries)', () => {
  it('runs a trivial osascript script fed on stdin and returns its output', async () => {
    const { execWithStdin } = await import('../../../src/native/exec.js');
    const result = await execWithStdin('osascript', ['-'], 'return "ok"', { timeoutMs: 5000, maxBufferBytes: 1024 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('round-trips through the real clipboard and restores the previous content afterwards', async () => {
    const { execWithStdin } = await import('../../../src/native/exec.js');
    const before = (await execWithStdin('pbpaste', [], '', { timeoutMs: 5000, maxBufferBytes: 65536 })).stdout;
    try {
      await execWithStdin('pbcopy', [], 'enigma-e2e-probe', { timeoutMs: 5000, maxBufferBytes: 65536 });
      const after = (await execWithStdin('pbpaste', [], '', { timeoutMs: 5000, maxBufferBytes: 65536 })).stdout;
      expect(after).toBe('enigma-e2e-probe');
    } finally {
      await execWithStdin('pbcopy', [], before, { timeoutMs: 5000, maxBufferBytes: 65536 });
    }
  });
});
