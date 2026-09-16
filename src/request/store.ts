// One-time request/reveal store (D2.1, D2.4, D2.7). In-memory only: a request
// or reveal is meaningless once the process that created it exits, and no
// value is ever held here — only names, metadata, and per-name outcomes.
import { randomBytes } from 'node:crypto';
import type { DepositoryId } from '../storage/interfaces.js';
import type { Scope } from '../core/index-store.js';

export type RequestKind = 'request' | 'reveal';

/** Outcome of writing one name through the storage core; never a value or a message that could carry one. */
export interface RequestNameResult {
  name: string;
  ok: boolean;
  errorCode?: string;
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
    if (opts.names.length < 1 || opts.names.length > 10) {
      throw new Error('a request must cover between 1 and 10 secret names');
    }
    if (opts.kind === 'reveal' && opts.names.length !== 1) {
      throw new Error('a reveal covers exactly one secret name');
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
   * period elapses.
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
    const waiter = waiters.get(id);
    if (waiter) {
      waiter.resolve('fulfilled');
      waiters.delete(id);
    }
    return record;
  },

  /** Records per-name write outcomes (Issue #10 reads this via `get` after the waiter resolves). No-op if the id is unknown. */
  setResults(id: string, results: RequestNameResult[]): void {
    const record = records.get(id);
    if (record) record.results = results;
  },

  /** Resolves to the literal 'fulfilled' once the id is marked used; rejects if the id is unknown or expires first. Never carries a value. */
  waitForFulfilled(id: string): Promise<'fulfilled'> {
    const record = records.get(id);
    if (!record) return Promise.reject(new Error('request not found'));
    if (record.usedAt !== undefined) return Promise.resolve('fulfilled');

    let waiter = waiters.get(id);
    if (!waiter) {
      waiter = deferred<'fulfilled'>();
      waiters.set(id, waiter);
    }
    return waiter.promise;
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
