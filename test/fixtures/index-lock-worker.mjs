// Real-process helper for test/integration/index-lock-kernel.test.ts.
//
// Loads the COMMITTED flock addon directly (createRequire on the artifact
// path passed in argv) and operates on an explicit anchor path, so the
// parent vitest process and the children contend on exactly one file the
// way independent Enigma processes do. Modes:
//
//   counter <addon> <anchor> <counterFile> <iters> <holdMs>
//     Per iteration: acquire (bounded) → read counter → sleep holdMs →
//     write counter+1 → release. The sleep widens the read-modify-write
//     window: if two children ever hold the lock at once, updates are lost
//     and the parent's expected total is not reached.
//   hold <addon> <anchor> pause
//     Acquire once, print LOCKED, then SIGSTOP self (paused-but-alive).
//   hold <addon> <anchor> park
//     Acquire once, print LOCKED, then idle until the parent kills us.
//
// Prints "LOCKED\n" (hold modes) or "DONE\n" (counter mode) on stdout.
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [, , mode, addonPath, anchorPath, ...rest] = process.argv;
const require = createRequire(import.meta.url);
const addon = require(addonPath);

function openAnchor(path) {
  try {
    return openSync(path, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return openSync(path, 'r+');
  }
}

function acquire(fd, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (addon.tryLockSync(fd)) return;
    if (Date.now() > deadline) throw new Error('worker acquire timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const fd = openAnchor(anchorPath);

if (mode === 'counter') {
  const [counterFile, itersRaw, holdMsRaw] = rest;
  const iters = Number(itersRaw);
  const holdMs = Number(holdMsRaw);
  for (let i = 0; i < iters; i++) {
    acquire(fd);
    const value = Number(readFileSync(counterFile, 'utf8') || '0');
    sleep(holdMs); // read-modify-write window — lost updates iff exclusion breaks
    writeFileSync(counterFile, String(value + 1));
    addon.unlockSync(fd);
  }
  closeSync(fd);
  process.stdout.write('DONE\n');
} else if (mode === 'hold') {
  const behavior = rest[0];
  acquire(fd);
  process.stdout.write('LOCKED\n');
  if (behavior === 'pause') {
    process.kill(process.pid, 'SIGSTOP');
  }
  // 'park': keep the event loop alive until killed.
  setInterval(() => {}, 1000);
} else {
  closeSync(fd);
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}
