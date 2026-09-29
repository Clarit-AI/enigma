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
//   timed <anchor> <iters> <holdMs> [gate]
//     Generic acquireFileLock exercise: `iters` cycles of
//     acquire → sleep(holdMs) → release on the given anchor (a
//     kernel lock file path). Prints `[startMs,endMs]` for each
//     cycle on stdout so the parent test can assert the critical
//     sections of two children on DIFFERENT anchors actually
//     overlap — proving distinct anchors don't serialize. With the
//     optional `gate` flag the worker prints `ready` and blocks on
//     stdin until the parent writes a line, so both children start
//     their first acquire together however slowly each one spawned.
//
// Argv is read positionally — names with spaces are not supported
// and not needed for the test surface (the project ID, worktree, and
// file come from the integration test as fixed strings).
import { readSync } from 'node:fs';
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
  const [anchor, itersRaw, holdMsRaw, gate] = rest;
  const iters = Number(itersRaw);
  const holdMs = Number(holdMsRaw);
  if (!anchor || !Number.isFinite(iters) || !Number.isFinite(holdMs)) {
    process.stderr.write(`usage: timed <anchor> <iters> <holdMs> [gate]\n`);
    process.exit(2);
  }
  if (gate === 'gate') {
    process.stdout.write('ready\n');
    // Block until the parent releases both children. EAGAIN (non-blocking
    // stdin) → retry; any other error or EOF → start without waiting, so
    // the fixture never dies at top level (Kilo r5).
    for (;;) {
      try {
        readSync(0, Buffer.alloc(1));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }
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