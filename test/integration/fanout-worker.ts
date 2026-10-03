// Real-process worker for the Issue #108 fan-out race test. Bundled by the test itself
// (esbuild, in beforeAll) and spawned with `node`; it calls the real `setSecret`.
//
//   fanout-worker <cwd> <name> <value> [goFile signalFile]
//
// Environment: FANOUT_CREATE=1 creates (no rotate). FANOUT_HOLD_AFTER_GUARD=<goFile>:<signalFile> blocks
// INSIDE the fan-out, with the per-NAME and per-file locks held and the commit guard already passed, until
// goFile exists (a synchronous wait: this process does nothing else meanwhile).
//
// Prints `COMMIT <updatedAt>` once its index commit is done and its fan-out is about to run.
// With goFile/signalFile it then writes signalFile and blocks until goFile exists, so the test
// can let a LATER commit fan out first and release this (now stale) fan-out afterwards.
import { existsSync, writeFileSync } from 'node:fs';
import { __setFanoutGateForTesting, __setFanoutHooksForTesting } from '../../src/render/fanout.js';
import { setSecret } from '../../src/storage/manager.js';

const [, , cwd, name, value, goFile, signalFile] = process.argv;
if (!cwd || !name || value === undefined) {
  process.stderr.write('usage: fanout-worker <cwd> <name> <value> [goFile signalFile]\n');
  process.exit(2);
}

__setFanoutGateForTesting(async (commit) => {
  process.stdout.write(`COMMIT ${commit?.updatedAt ?? ''}\n`);
  if (signalFile) writeFileSync(signalFile, 'committed');
  if (goFile) {
    while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 20));
  }
});

const hold = process.env.FANOUT_HOLD_AFTER_GUARD;
if (hold) {
  const [holdGo, holdSignal] = hold.split(':') as [string, string];
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  __setFanoutHooksForTesting({
    afterGuard: () => {
      writeFileSync(holdSignal, 'guarded');
      while (!existsSync(holdGo)) Atomics.wait(sleeper, 0, 0, 20);
    },
  });
}

const result = await setSecret({ name, value, scope: 'project', depository: 'encrypted', cwd, rotate: process.env.FANOUT_CREATE !== '1', actor: 'cli' });
process.stdout.write(`DONE ${result.warnings.length}\n`);
