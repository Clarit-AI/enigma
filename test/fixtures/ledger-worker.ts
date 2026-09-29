// Real-process fixture for Issue #106's render-ledger tests.
//
// Bundled to a per-run path under os.tmpdir() by the vitest
// globalSetup (scripts/build-ledger-fixture.mjs); the integration
// test spawns the bundled file with `node`. The fixture itself uses
// the same TypeScript imports a real caller would.
//
// Modes (chosen by argv[2]):
//   upsert <projectId> <worktree> <file> <name1> <name2> ...
//     Calls `upsertTarget` with the given args; prints the resulting
//     `renderedAt` on stdout, then exits 0.
//   remove <name1> <name2> ...
//     Calls `removeNames` with the given args; prints "OK" on stdout,
//     then exits 0.
//   timed <anchor> <iters> <holdMs> [startAtMs]
//     Generic acquireFileLock exercise: `iters` cycles of
//     acquire → sleep(holdMs) → release on the given anchor (a
//     kernel lock file path). Prints `[startMs,endMs]` for each
//     cycle on stdout so the parent test can assert the critical
//     sections of two children on DIFFERENT anchors actually
//     overlap — proving distinct anchors don't serialize. The
//     optional `startAtMs` is a wall-clock start barrier, so a slow
//     spawn of one child cannot push it past the other's whole run.
//
// Argv is read positionally — names with spaces are not supported
// and not needed for the test surface (the project ID, worktree, and
// file come from the integration test as fixed strings).
import { acquireFileLock } from '../../src/core/file-lock.js';
import { upsertTarget, removeNames } from '../../src/render/ledger.js';

const [, , mode, ...rest] = process.argv;

if (mode === 'upsert') {
  const [projectId, worktree, file, ...names] = rest;
  if (!projectId || !worktree || !file || names.length === 0) {
    process.stderr.write(`usage: upsert <projectId> <worktree> <file> <name> [<name> ...]\n`);
    process.exit(2);
  }
  const result = upsertTarget({ projectId, worktree, file, names });
  process.stdout.write(`${result?.renderedAt ?? ''}\n`);
} else if (mode === 'remove') {
  if (rest.length === 0) {
    process.stderr.write(`usage: remove <name> [<name> ...]\n`);
    process.exit(2);
  }
  removeNames(rest);
  process.stdout.write('OK\n');
} else if (mode === 'timed') {
  const [anchor, itersRaw, holdMsRaw, startAtRaw] = rest;
  const iters = Number(itersRaw);
  const holdMs = Number(holdMsRaw);
  if (!anchor || !Number.isFinite(iters) || !Number.isFinite(holdMs)) {
    process.stderr.write(`usage: timed <anchor> <iters> <holdMs> [startAtMs]\n`);
    process.exit(2);
  }
  const waitMs = Number(startAtRaw ?? 0) - Date.now();
  if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  for (let i = 0; i < iters; i++) {
    const lock = acquireFileLock(anchor, 'timed worker');
    try {
      const start = Date.now();
      // Cooperative sleep — the worker holds the lock for `holdMs`.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      const end = Date.now();
      process.stdout.write(`[${start},${end}]\n`);
    } finally {
      lock.release();
    }
  }
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}