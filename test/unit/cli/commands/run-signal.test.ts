import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSecret } from '../../../../src/storage/manager.js';
import { cmdRun } from '../../../../src/cli/commands/run.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

// Issue #22, AC #7: integration test for the killed-by-signal exit path. This test
// file deliberately does NOT mock `node:child_process` (unlike the other run.test.ts),
// so it exercises the real `spawn` → kernel → `child.on('exit', …)` pipeline. The
// mocked-spawn counterpart (run.test.ts) covers the math (`code === 128 + signum`);
// this file proves the math actually fires for a real child process. If the mock
// were ever removed from the rest of run.test.ts, this file would still be the
// definitive end-to-end check.
//
// The test spawns a real Node child that kills itself with SIGTERM. We assert
// exit code 128 + signum(SIGTERM) — the POSIX shell convention for "killed by
// signal N" (128+15=143 on Linux/macOS for SIGTERM).
describe('cmdRun signal-exit integration (Issue #22, AC #7)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    // Resolved so it matches process.cwd() after chdir on platforms where tmpdir() is a symlink (e.g. macOS).
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    process.chdir(tmpProject);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('returns 128 + signum for a real child that is killed by SIGTERM (Issue #22, AC #7)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    const code = await cmdRun(['--scope', 'global', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")']);

    const { constants: osConstants } = await import('node:os');
    const signum = (osConstants.signals as Record<string, number>).SIGTERM!;
    expect(code).toBe(128 + signum);
  }, 15_000);

  it('returns 128 + signum for a real child killed by SIGINT (POSIX shell convention)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    // process.kill with no signal argument sends SIGTERM by default; pass an explicit
    // signal string for clarity. We use SIGINT here to confirm the math isn't
    // hard-coded to SIGTERM.
    const code = await cmdRun(['--scope', 'global', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGINT")']);

    const { constants: osConstants } = await import('node:os');
    const signum = (osConstants.signals as Record<string, number>).SIGINT!;
    expect(code).toBe(128 + signum);
  }, 15_000);
});
