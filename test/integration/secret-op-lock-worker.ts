// Real-process worker for the Issue #125 / #87 lock tests. Bundled by secret-op-lock.test.ts (esbuild, in
// beforeAll) and spawned with `node`; it calls the real storage code.
//
//   secret-op-lock-worker vault <prefix> <count>                       — <count> encrypted `set`s straight to the
//                                                                         depository (vault lock only, Issue #87)
//   secret-op-lock-worker set <cwd> <name> <value> <depository> [goFile signalFile]
//                                                                       — a project rotate through `setSecret`; with
//                                                                         goFile/signalFile it writes signalFile after
//                                                                         its depository write and waits for goFile
//                                                                         BEFORE its index commit (op lock held)
//   secret-op-lock-worker move <cwd> <name> <to>                       — `enigma move NAME --to <to> --scope project`
//
// Exits 0 on success; on failure prints `ERR <code>` (never a value) and exits 1.
import { existsSync, writeFileSync } from 'node:fs';
import { cmdMove } from '../../src/cli/commands/move.js';
import { encryptedDepositoryModule } from '../../src/storage/depositories/encrypted.js';
import { __setSecretBeforeCommitHookForTesting, setSecret } from '../../src/storage/manager.js';
import type { DepositoryId } from '../../src/storage/interfaces.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const [, , mode, ...rest] = process.argv;

async function main(): Promise<number> {
  if (mode === 'vault') {
    const [prefix, count] = rest as [string, string];
    const dep = encryptedDepositoryModule.create({});
    for (let i = 0; i < Number(count); i++) await dep.set(`global/${prefix}${i}`, `value-${prefix}${i}`);
    return 0;
  }
  if (mode === 'set') {
    const [cwd, name, value, depository, goFile, signalFile] = rest as [string, string, string, string, string?, string?];
    if (goFile && signalFile) {
      __setSecretBeforeCommitHookForTesting(async () => {
        writeFileSync(signalFile, 'written');
        while (!existsSync(goFile)) await sleep(20);
      });
    }
    await setSecret({ name, value, scope: 'project', depository: depository as DepositoryId, cwd, rotate: true, actor: 'cli' });
    return 0;
  }
  if (mode === 'move') {
    const [cwd, name, to] = rest as [string, string, string];
    process.chdir(cwd);
    return cmdMove([name, '--to', to, '--scope', 'project']);
  }
  process.stderr.write('usage: secret-op-lock-worker vault|set|move ...\n');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    process.stderr.write(`ERR ${code}\n`);
    process.exit(1);
  },
);
