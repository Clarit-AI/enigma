import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryContext, DepositoryModule } from '../interfaces.js';

const OP_BIN = 'op';
const VAULT = 'Enigma';
const MIN_MAJOR_VERSION = 2;

/**
 * `op whoami` and `op --version` fail fast when signed out. Every other `op`
 * subcommand that touches vault/item data (`vault get`, `vault list`,
 * `item create`, `read`, …) instead tries an interactive authorization and
 * only gives up after ~60s ("authorization timeout"), confirmed empirically
 * against a real signed-out `op` install. Every invocation below is bounded
 * by this timeout so a signed-out or locked session degrades to a clear
 * error within seconds, never a silent stall. 15s (vs. `op`'s own 60s
 * default) still fails a signed-out session quickly while leaving room for
 * a signed-in user to actually answer a real Touch ID / unlock prompt —
 * keychain/secret-service use 10s, but neither of those ever raises a
 * human-facing OS prompt the way 1Password's biometric unlock can.
 */
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024;

/** `ref` is a depository-boundary input; validated before any process is spawned. Here `ref` is either `<scopeId>/<NAME>` on `set`, or an item id `op item create` returned on `resolve`/`delete`/`has` — an id derived from external tool output, which is exactly the case that makes this validation necessary. */
const REF_PATTERN = /^[A-Za-z0-9_./-]+$/;
const REF_MAX_LENGTH = 512;

/**
 * Best-effort classification of `op`'s stderr text. `op` has no stable,
 * documented machine-readable error taxonomy for "vault does not exist" vs.
 * "item does not exist" vs. any other failure, so — matching the existing
 * precedent in linux-secret-service.ts's `classifyUnavailable` — these are
 * pattern matches against the CLI's human-readable error text, not a
 * contract `op` promises to keep. The opt-in `ENIGMA_E2E_OP=1` suite
 * exercises these against the real binary.
 */
const VAULT_MISSING_PATTERN = /isn't a vault|no vault named|could not find vault/i;
const ITEM_MISSING_PATTERN = /isn't an item|could not find item|item.*not found/i;

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
}

/** Runs `op` with argv only, no stdin. */
function runOp(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Runs `op` with `stdinData` supplied on stdin — never argv. `error`
 * listeners on both the child and its stdin turn a pipe failure (e.g. the
 * child exiting before stdin drains) into a rejected promise instead of an
 * uncaught exception; `write()`'s backpressure signal is honoured rather
 * than ending stdin while a write is still buffered (mirrors
 * macos-keychain.ts / linux-secret-service.ts).
 */
function runOpWithStdin(args: string[], stdinData: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.on('error', reject);
    if (!child.stdin) {
      child.kill();
      reject(new Error('op: stdin unavailable'));
      return;
    }
    child.stdin.on('error', reject);
    if (child.stdin.write(stdinData)) {
      child.stdin.end();
    } else {
      child.stdin.once('drain', () => child.stdin?.end());
    }
  });
}

function isTimeout(failure: ExecFailure): boolean {
  return failure.killed === true || failure.signal != null;
}

function refInvalid(): never {
  throw new EnigmaError({
    code: 'E_REF_INVALID',
    message: `invalid depository ref: expected ${REF_PATTERN} and at most ${REF_MAX_LENGTH} characters`,
    depository: '1password',
  });
}

function validateRef(ref: string): void {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH || !REF_PATTERN.test(ref)) {
    refInvalid();
  }
}

function writeFailed(reason?: string): never {
  throw new EnigmaError({
    code: 'E_WRITE_FAILED',
    message: reason ?? 'failed to write secret to 1password depository',
    depository: '1password',
  });
}

function readFailed(reason?: string): never {
  throw new EnigmaError({
    code: 'E_READ_FAILED',
    message: reason ?? 'failed to read secret from 1password depository',
    depository: '1password',
  });
}

function notFound(): never {
  throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: '1password' });
}

function vaultMissing(): never {
  throw new EnigmaError({
    code: 'E_VAULT_MISSING',
    message: `the "${VAULT}" vault does not exist in 1Password; pass createVault to create it`,
    depository: '1password',
  });
}

/**
 * Read-only pre-flight probe (Issue #28): unlike `set`'s own vault-missing
 * detection, this never creates anything, so it's safe to call before a user
 * has confirmed anything. It exists specifically for the web request/import
 * forms, which must know whether creating the vault needs confirming
 * *before* consuming their one-time request id (S2.1 forbids a write before
 * that id is consumed) — `enigma add` and `enigma_request` don't need this,
 * since they can act directly on the `E_VAULT_MISSING` a real `set` attempt
 * raises. `detect()` deliberately never makes a vault-touching call (see its
 * own comment) because it runs on every `detectAll()`; this runs at most
 * once per submission, only for a depository the user actually picked, so
 * the same cost is justified here where it wasn't there. Ambiguous outcomes
 * (a timeout, or any `op` failure that isn't recognizably "no such vault")
 * report "not missing" — deferring to the real `set` attempt, which is
 * better positioned to surface the concrete error.
 */
export async function checkOnepasswordVaultMissing(): Promise<boolean> {
  try {
    await runOp(['vault', 'get', VAULT, '--format', 'json']);
    return false;
  } catch (err) {
    const failure = err as ExecFailure;
    if (isTimeout(failure)) return false;
    return VAULT_MISSING_PATTERN.test(failure.stderr ?? '');
  }
}

function timedOut(op: 'read' | 'write'): never {
  const message = `1password depository timed out waiting for the op CLI after ${EXEC_TIMEOUT_MS}ms; run "op signin" or unlock 1Password and try again`;
  if (op === 'read') readFailed(message);
  writeFailed(message);
}

/** Item id (this depository's ref, once stored) parsed from the ref given to `set`, which is `<scopeId>/<NAME>`. */
function nameFromRef(ref: string): string {
  const idx = ref.lastIndexOf('/');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

/**
 * `NAME` for global scope, `NAME · <project folder>` for project scope
 * (D1.9). Titles are cosmetic only — reads go by item id — so an absent
 * `projectPath` for what the ref says is a project-scoped entry falls back
 * to the bare name rather than failing `set`.
 */
function buildTitle(ref: string, ctx: DepositoryContext): string {
  const name = nameFromRef(ref);
  const isGlobal = ref === name || ref.startsWith('global/');
  if (isGlobal || !ctx.projectPath) return name;
  return `${name} · ${basename(ctx.projectPath)}`;
}

interface OpItemCreateResponse {
  id?: unknown;
}

function itemTemplate(title: string, value: string): string {
  return JSON.stringify({
    title,
    category: 'API_CREDENTIAL',
    fields: [{ id: 'credential', type: 'CONCEALED', label: 'credential', value }],
  });
}

async function createVault(): Promise<void> {
  try {
    await runOp(['vault', 'create', VAULT, '--format', 'json']);
  } catch (err) {
    const failure = err as ExecFailure;
    if (isTimeout(failure)) timedOut('write');
    writeFailed(`failed to create the "${VAULT}" vault in 1Password`);
  }
}

async function createItem(title: string, value: string): Promise<string> {
  const { stdout } = await runOpWithStdin(['item', 'create', '--vault', VAULT, '--format', 'json', '-'], itemTemplate(title, value));
  let parsed: OpItemCreateResponse;
  try {
    parsed = JSON.parse(stdout) as OpItemCreateResponse;
  } catch {
    return writeFailed('op item create returned a response that could not be parsed');
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    return writeFailed('op item create did not return an item id');
  }
  return parsed.id;
}

function createOnepasswordDepository(ctx: DepositoryContext): Depository {
  return {
    id: '1password',
    promptProfile: 'prompts-each-read',

    async set(ref, value) {
      validateRef(ref);
      const title = buildTitle(ref, ctx);

      try {
        return await createItem(title, value);
      } catch (err) {
        const failure = err as ExecFailure;
        if (isTimeout(failure)) timedOut('write');
        if (VAULT_MISSING_PATTERN.test(failure.stderr ?? '')) {
          if (!ctx.createVault) vaultMissing();
          await createVault();
          try {
            return await createItem(title, value);
          } catch (retryErr) {
            const retryFailure = retryErr as ExecFailure;
            if (isTimeout(retryFailure)) timedOut('write');
            return writeFailed();
          }
        }
        return writeFailed();
      }
    },

    async resolve(ref) {
      validateRef(ref);
      try {
        const { stdout } = await runOp(['read', `op://${VAULT}/${ref}/credential`]);
        return stdout.replace(/\n$/, '');
      } catch (err) {
        const failure = err as ExecFailure;
        if (isTimeout(failure)) timedOut('read');
        if (ITEM_MISSING_PATTERN.test(failure.stderr ?? '')) notFound();
        return readFailed();
      }
    },

    async delete(ref) {
      validateRef(ref);
      try {
        await runOp(['item', 'delete', ref, '--vault', VAULT]);
      } catch (err) {
        const failure = err as ExecFailure;
        if (isTimeout(failure)) timedOut('read');
        if (ITEM_MISSING_PATTERN.test(failure.stderr ?? '')) return;
        readFailed();
      }
    },

    async has(ref) {
      validateRef(ref);
      try {
        await runOp(['item', 'get', ref, '--vault', VAULT]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function parseMajorVersion(stdout: string): number | undefined {
  const match = /^(\d+)\./.exec(stdout.trim());
  return match ? Number(match[1]) : undefined;
}

export const onepasswordDepositoryModule: DepositoryModule = {
  id: '1password',
  promptProfile: 'prompts-each-read',

  /**
   * Available only when `op --version` is 2.x+ and `op whoami` succeeds —
   * both fail fast and never prompt. Vault existence is deliberately not
   * checked here (that's a `set`-time concern, AC2) since any vault-touching
   * `op` subcommand risks the ~60s authorization-timeout hang this module
   * otherwise avoids.
   */
  async detect() {
    let versionOut: string;
    try {
      versionOut = (await runOp(['--version'])).stdout;
    } catch (err) {
      const failure = err as ExecFailure;
      const reason = failure.code === 'ENOENT' ? 'op CLI not installed' : 'op --version failed';
      return { id: '1password', promptProfile: 'prompts-each-read', available: false, reason };
    }

    const major = parseMajorVersion(versionOut);
    if (major === undefined || major < MIN_MAJOR_VERSION) {
      return {
        id: '1password',
        promptProfile: 'prompts-each-read',
        available: false,
        reason: `op CLI version ${versionOut.trim() || 'unknown'} is older than the required ${MIN_MAJOR_VERSION}.x`,
      };
    }

    try {
      await runOp(['whoami']);
    } catch {
      return {
        id: '1password',
        promptProfile: 'prompts-each-read',
        available: false,
        reason: 'op CLI is not signed in (run `op signin`)',
      };
    }

    return { id: '1password', promptProfile: 'prompts-each-read', available: true };
  },

  create: createOnepasswordDepository,
};
