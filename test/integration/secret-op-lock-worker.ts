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
//   secret-op-lock-worker import <cwd> <sourceFile> <content> <count>  — <count> times: write <content> to
//                                                                         <sourceFile>, then `commitImport` it into
//                                                                         encrypted with rotate (Issue #133). A
//                                                                         failed entry exits 1 with `ERR <code>`.
//                                                                         LOCK_TIMEOUT_MS shortens the op-lock wait;
//                                                                         LOCK_STEP_MS pauses between batch locks.
//
// Exits 0 on success; on failure prints `ERR <code>` (never a value) and exits 1.
import { existsSync, writeFileSync } from 'node:fs';
import { cmdMove } from '../../src/cli/commands/move.js';
import { __setAsyncLockTimingForTesting } from '../../src/core/file-lock.js';
import { parseDotEnv } from '../../src/storage/dotenv-file.js';
import { commitImport } from '../../src/storage/import-commit.js';
import { __setOpLocksStepDelayForTesting } from '../../src/storage/op-lock.js';
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
  if (mode === 'import') {
    const [cwd, sourceFile, content, count] = rest as [string, string, string, string];
    if (process.env.LOCK_TIMEOUT_MS) __setAsyncLockTimingForTesting({ timeoutMs: Number(process.env.LOCK_TIMEOUT_MS) });
    if (process.env.LOCK_STEP_MS) __setOpLocksStepDelayForTesting(Number(process.env.LOCK_STEP_MS));
    for (let i = 0; i < Number(count); i++) {
      writeFileSync(sourceFile, content);
      const result = await commitImport({
        entries: parseDotEnv(content).entries,
        depository: 'encrypted',
        scope: 'project',
        cwd,
        projectPath: cwd,
        envFilePath: sourceFile,
        actor: 'cli',
        rotate: true,
      });
      if (result.failed.length > 0) {
        process.stderr.write(`ERR ${result.failed[0]!.errorCode}\n`);
        return 1;
      }
    }
    return 0;
  }
  process.stderr.write('usage: secret-op-lock-worker vault|set|move|import ...\n');
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
