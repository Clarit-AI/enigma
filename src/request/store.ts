// One-time request/reveal store (D2.1, D2.4, D2.7). In-memory only: a request
// or reveal is meaningless once the process that created it exits, and no
// value is ever held here — only names, metadata, and per-name outcomes.
import { randomBytes } from 'node:crypto';
import type { DepositoryId } from '../storage/interfaces.js';
import type { Scope } from '../core/index-store.js';

export type RequestKind = 'request' | 'reveal' | 'import';

/**
 * Outcome of writing one name through the storage core; never a value or a
 * message that could carry one. `reason` is the one narrow, deliberate
 * exception (Issue #13 review, round 4, finding 2): kind 'import' only,
 * populated ONLY from `ParsedDotEnvEntry.ambiguousReason` — static text
 * about structure ("assigned more than once in this file", "quote the value
 * if the # belongs to it") computed by the parser before any value is
 * looked at, plus the entry's own name and file path. Never populate this
 * from an EnigmaError's `.message` in general, or from anything else
 * derived from a parsed value — widening this field is exactly how a
 * value-carrying string gets introduced here by someone with good
 * intentions later. If you're tempted to set `reason` for a NEW error code,
 * stop and ask whether that code's message can ever embed a value; if it
 * can, it does not belong here. (Every file that constructs a RequestNameResult is
 * enumerated in test/unit/reason-field-surfaces.test.ts, with a golden snapshot of
 * its `reason:` assignments — Issue #38. A new or changed assignment fails that test.)
 */
export interface RequestNameResult {
  name: string;
  ok: boolean;
  errorCode?: string;
  reason?: string;
}

export interface RequestRecord {
  id: string;
  kind: RequestKind;
  names: string[];
  reason?: string;
  usage?: 'interactive' | 'unattended';
  depository?: DepositoryId;
  scope?: Scope;
  rotate?: boolean;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  /** Set once POST /r/:id has attempted a write for every name (Issue #10 reads this after the waiter resolves). */
  results?: RequestNameResult[];
  /**
   * Set the first time `consumeOutcome` reads this record's `results` — i.e.
   * the first time an `enigma_await`/`enigma_request`/`enigma_import` call
   * actually returns the outcome text to the model (Issue #62). Distinct
   * from `usedAt` (set when the human submits the form) and from `results`
   * being set (the web layer recording what happened): this timestamp is
   * about whether the AGENT has learned the outcome, which can lag well
   * behind either. Never set by `listUnconsumedFulfilled` itself — reading
   * the recovery signal must not erase it.
   */
  outcomeConsumedAt?: number;
  /**
   * kind 'import' only: the already-parsed values keyed by name, carried
   * in-flight from the CLI/MCP process that read the source `.env` through
   * to the web POST handler that commits them (style-guide: `src/request/**`
   * may hold a value in flight). Never logged.
   */
  values?: Record<string, string>;
  /** kind 'import' only: the source `.env`-format file to rewrite once every name is stored. */
  envFilePath?: string;
  /** kind 'import' only: names flagged ambiguous at parse time (an inline-comment-like value, or a duplicated key) — the web POST handler must refuse these exactly as the direct --depository path does (Issue #13 review, round 2 A2 / round 3 item 1), never silently drop the flag going into the picker. */
  ambiguousNames?: string[];
  /** kind 'import' only: the specific reason for each name in `ambiguousNames`, so the picker path's refusal message names the same thing (a duplicated key vs. an ambiguous inline comment) as the direct --depository path (Issue #13 review, round 4). */
  ambiguousReasons?: Record<string, string>;
  /** kind 'import' only: set by the web POST handler alongside `results`, read back by the CLI/MCP caller after the waiter resolves. */
  importOutcome?: { fileRewritten: boolean; warnings: string[]; skippedMismatch: string[]; depository?: DepositoryId };
}

export interface CreateRequestOptions {
  kind: RequestKind;
  names: string[];
  reason?: string;
  usage?: 'interactive' | 'unattended';
  depository?: DepositoryId;
  scope?: Scope;
  rotate?: boolean;
  /** Overrides the kind-based default (D2.1: 15 min for a request, 5 min for a reveal). */
  ttlMs?: number;
  /** kind 'import' only. */
  values?: Record<string, string>;
  /** kind 'import' only. */
  envFilePath?: string;
  /** kind 'import' only. */
  ambiguousNames?: string[];
  /** kind 'import' only. */
  ambiguousReasons?: Record<string, string>;
}

const REQUEST_TTL_MS = 15 * 60 * 1000;
const REVEAL_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** How long a used record is kept around after use, so the done/reveal page can still be rendered. */
const USED_GRACE_MS = 5 * 60 * 1000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defaultTtlMs(kind: RequestKind): number {
  return kind === 'reveal' ? REVEAL_TTL_MS : REQUEST_TTL_MS;
}

const records = new Map<string, RequestRecord>();
const waiters = new Map<string, Deferred<'fulfilled'>>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function isExpired(record: RequestRecord, now: number): boolean {
  return now > record.expiresAt;
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

function sweep(): void {
  const now = Date.now();
  for (const [id, record] of records) {
    if (record.usedAt !== undefined) {
      if (now - record.usedAt > USED_GRACE_MS) records.delete(id);
      continue;
    }
    if (isExpired(record, now)) {
      records.delete(id);
      const waiter = waiters.get(id);
      if (waiter) {
        waiter.reject(new Error('request expired'));
        waiters.delete(id);
      }
    }
  }
}

export const RequestStore = {
  /** 32-hex id (128-bit random). Throws on a malformed kind/names combination (a caller bug, not reachable via HTTP input). */
  create(opts: CreateRequestOptions): RequestRecord {
    if (opts.kind === 'reveal') {
      if (opts.names.length !== 1) throw new Error('a reveal covers exactly one secret name');
    } else if (opts.kind === 'import') {
      // No typing-cost limit applies here (the values are already known); bounded generously against a runaway .env.
      if (opts.names.length < 1 || opts.names.length > 200) {
        throw new Error('an import must cover between 1 and 200 secret names');
      }
    } else if (opts.names.length < 1 || opts.names.length > 10) {
      throw new Error('a request must cover between 1 and 10 secret names');
    }

    const id = randomBytes(16).toString('hex');
    const now = Date.now();
    const record: RequestRecord = {
      id,
      kind: opts.kind,
      names: [...opts.names],
      reason: opts.reason,
      usage: opts.usage,
      depository: opts.depository,
      scope: opts.scope,
      rotate: opts.rotate,
      createdAt: now,
      expiresAt: now + (opts.ttlMs ?? defaultTtlMs(opts.kind)),
      values: opts.values ? { ...opts.values } : undefined,
      envFilePath: opts.envFilePath,
      ambiguousNames: opts.ambiguousNames ? [...opts.ambiguousNames] : undefined,
      ambiguousReasons: opts.ambiguousReasons ? { ...opts.ambiguousReasons } : undefined,
    };
    records.set(id, record);
    startSweeper();
    return record;
  },

  /** Expiry-aware lookup. Returns the record while it is used-and-within-grace even past its TTL, so a 410 (not 404) can be rendered. */
  get(id: string): RequestRecord | undefined {
    const record = records.get(id);
    if (!record) return undefined;
    if (record.usedAt === undefined && isExpired(record, Date.now())) return undefined;
    return record;
  },

  /**
   * Atomically checks existence, non-expiry, and non-use, then marks used.
   * This is the security boundary (S2.1): once it returns a record, every
   * later call for the same id returns undefined until the sweeper's grace
   * period elapses. Deliberately does NOT resolve the fulfilment waiter —
   * marking a token used and reporting what happened are two different
   * moments (see `fulfill`); a caller that wrote a value after this call
   * returns is still free to fail before ever calling `fulfill`.
   */
  tryMarkUsed(id: string): RequestRecord | undefined {
    const record = records.get(id);
    if (!record) return undefined;
    if (isExpired(record, Date.now())) {
      records.delete(id);
      return undefined;
    }
    if (record.usedAt !== undefined) return undefined;

    record.usedAt = Date.now();
    return record;
  },

  /**
   * Records the outcome of a used request/reveal and THEN resolves the
   * fulfilment waiter, in that order — a caller waking up from
   * `waitForFulfilled` is therefore guaranteed `get(id)?.results` is already
   * readable. `results` defaults to `[]` for a reveal, which has no
   * per-name write outcome to report but still needs the waiter to resolve
   * once the human has revealed it. No-op if the id is unknown.
   */
  fulfill(id: string, results: RequestNameResult[] = []): void {
    const record = records.get(id);
    if (record) record.results = results;

    const waiter = waiters.get(id);
    if (waiter) {
      waiter.resolve('fulfilled');
      waiters.delete(id);
    }
  },

  /**
   * Resolves to the literal 'fulfilled' once `fulfill` has run for this id —
   * meaning the single-use token was consumed AND its outcome (`results`) is
   * already readable — or rejects if the id is unknown or expires first.
   * `fulfilled` means only that: a human completed the interaction. It says
   * nothing about per-name outcome, which `results` alone carries. Never
   * carries a value.
   */
  waitForFulfilled(id: string): Promise<'fulfilled'> {
    const record = records.get(id);
    if (!record) return Promise.reject(new Error('request not found'));
    if (record.results !== undefined) return Promise.resolve('fulfilled');

    let waiter = waiters.get(id);
    if (!waiter) {
      waiter = deferred<'fulfilled'>();
      waiters.set(id, waiter);
    }
    return waiter.promise;
  },

  /**
   * Reads a fulfilled record's per-name results and marks its outcome as
   * consumed the first time this is called for a given id (Issue #62) — the
   * single choke point `resolveRequestOutcome` (used by enigma_await,
   * enigma_request, and enigma_import) reads through, so
   * `listUnconsumedFulfilled` can tell "the agent already learned this
   * outcome" from "it never did." Idempotent: a second `enigma_await` for
   * the same id still returns the same results (that's the whole point of
   * the idempotent-await recovery path) and leaves `outcomeConsumedAt` at
   * its first value. Returns undefined if the id is unknown or not yet
   * fulfilled — callers already treat that the same as "no results".
   */
  consumeOutcome(id: string): RequestNameResult[] | undefined {
    const record = records.get(id);
    if (!record || record.results === undefined) return undefined;
    if (record.outcomeConsumedAt === undefined) record.outcomeConsumedAt = Date.now();
    return record.results;
  },

  /**
   * Enumerates fulfilled 'request'/'import' records (results are in) whose
   * outcome has never been read via `consumeOutcome` — Issue #62's recovery
   * signal for an `enigma_await`/`enigma_request` call that was interrupted
   * before the agent ever saw the outcome text, even though the secret was
   * stored correctly by the independent web layer. 'reveal' records are
   * excluded: `enigma_reveal` never blocks on `resolveRequestOutcome` (by
   * design — the revealed value goes only to the human), so a fulfilled
   * reveal has nothing pending for the agent to re-await.
   *
   * Returns names and ids only, never values or per-name results (ADR-001)
   * — this is purely "there is an outcome you may not have seen; call
   * enigma_await(id)", not the outcome itself. Reading this list never
   * marks anything consumed, so calling it repeatedly (e.g. from
   * enigma_doctor) cannot make the signal disappear on its own. Bounded by
   * the same in-memory TTL/used-grace sweep as every other record; no new
   * persistence.
   */
  listUnconsumedFulfilled(): Array<{ id: string; names: string[] }> {
    const out: Array<{ id: string; names: string[] }> = [];
    for (const record of records.values()) {
      if (record.kind === 'reveal') continue;
      if (record.results === undefined) continue;
      if (record.outcomeConsumedAt !== undefined) continue;
      out.push({ id: record.id, names: [...record.names] });
    }
    return out;
  },

  /** Test-only: clears all records/waiters and stops the sweeper so state never leaks between test files. */
  __resetForTests(): void {
    records.clear();
    waiters.clear();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  },
};
