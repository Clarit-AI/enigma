// Real-process fixture for Issue #106's render-ledger concurrency test.
//
// Bundled to `test/fixtures/ledger-worker.mjs` by the vitest globalSetup
// (scripts/build-ledger-fixture.mjs) before the integration suite runs;
// the integration test spawns the bundled file with `node`. The fixture
// itself uses the same TypeScript imports a real caller would.
//
// Modes (chosen by argv[2]):
//   upsert <projectId> <worktree> <file> <name1> <name2> ...
//     Calls `upsertTarget` with the given args; prints the resulting
//     `renderedAt` on stdout, then exits 0.
//   remove <name1> <name2> ...
//     Calls `removeNames` with the given args; prints "OK" on stdout,
//     then exits 0.
//
// Argv is read positionally — names with spaces are not supported and
// not needed for the test surface (the project ID, worktree, and file
// come from the integration test as fixed strings).
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
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}