import * as http from 'node:http';
import { RequestStore } from '../request/store.js';
import { decideInsecureHttpPolicy } from './network-policy.js';
import { handleRequest } from './router.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Defensive floor on the re-arm delay (Issue #69 AC #9): keeps the timer
 *  from spinning. Reachable in practice, not just defensively — at exactly
 *  `now === expiresAt` (the boundary `earliestOpenExpiry` treats as still
 *  open, PR #78 review), `expiry - now + 1` is `1`, so this floor is what
 *  actually supplies the re-arm delay at that instant. */
const MIN_REARM_DELAY_MS = 1000;

export interface StartServerOptions {
  host?: string;
  idleTimeoutMs?: number;
  allowInsecureHttp?: boolean;
}

export interface ServerHandle {
  port: number;
  origin: string;
  close(): Promise<void>;
}

interface ServerState {
  server: http.Server;
  port: number;
  host: string;
  idleTimeoutMs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

let state: ServerState | undefined;
let starting: Promise<ServerHandle> | undefined;

function settled<T>(value: T): Promise<T> {
  return new Promise((resolve) => resolve(value));
}

function toHandle(s: ServerState): ServerHandle {
  return { port: s.port, origin: `http://${s.host}:${s.port}`, close: stopServer };
}

/** When the idle timer fires, do not close the server while any `RequestStore`
 *  record is still `open` (Issue #69 §3): `usedAt === undefined &&
 *  now <= expiresAt` (boundary decided on PR #78 review — see
 *  `earliestOpenExpiry`'s own doc comment). Re-arm to the smaller of
 *  `idleTimeoutMs` (so a request created long after the original arm still
 *  gets a full idle window on the next fire) and the moment the earliest
 *  open request expires (so the server stays up until just past the
 *  request's TTL, then closes). The HTTP-triggered `resetIdleTimer` path is
 *  unchanged — it still arms the full `idleTimeoutMs` so the existing
 *  per-request-reset test stays green. */
function onIdleTimer(): void {
  const current = state;
  if (!current) return;
  const now = Date.now();
  const expiry = RequestStore.earliestOpenExpiry(now);
  if (expiry === undefined) {
    void stopServer();
    return;
  }
  const delay = Math.max(MIN_REARM_DELAY_MS, Math.min(current.idleTimeoutMs, expiry - now + 1));
  current.idleTimer = setTimeout(onIdleTimer, delay);
  current.idleTimer.unref();
}

function resetIdleTimer(s: ServerState): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(onIdleTimer, s.idleTimeoutMs);
  s.idleTimer.unref();
}

/** Starts the local server lazily; a second call while one is already running reuses the same instance and resets its idle-close timer. */
export function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  if (state) {
    resetIdleTimer(state);
    return settled(toHandle(state));
  }
  if (starting) return starting;

  const host = opts.host ?? DEFAULT_HOST;
  const policy = decideInsecureHttpPolicy(host, opts.allowInsecureHttp ?? false);
  if (!policy.allow) {
    return new Promise((_resolve, reject) =>
      reject(new Error(`refusing to bind ${host} over plain HTTP; pass allowInsecureHttp to override (ADR-005)`)),
    );
  }

  starting = new Promise<ServerHandle>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (state) resetIdleTimer(state);
      void handleRequest(req, res);
    });

    server.on('error', (err) => {
      starting = undefined;
      reject(err);
    });

    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const newState: ServerState = { server, port, host, idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS };
      state = newState;
      resetIdleTimer(newState);
      starting = undefined;
      resolve(toHandle(newState));
    });
  });

  return starting;
}

/** Closes the running server, if any. Safe to call when nothing is running (no-op). */
export function stopServer(): Promise<void> {
  const current = state;
  if (!current) return settled(undefined);
  state = undefined;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  return new Promise((resolve) => current.server.close(() => resolve()));
}

/**
 * Test-only: reads whether the server is currently running, and on which
 * port, with no side effects — unlike `startServer()` (which calls
 * `resetIdleTimer` whenever a server is already up) or an actual HTTP
 * request (whose handler does the same), either of which would mask
 * whether `onIdleTimer`'s own re-arm/close logic — the exact thing a
 * boundary or long-duration idle-timer test needs to observe — actually
 * ran (PR #78 review, AC #9 boundary evidence / AC #6 production-duration
 * evidence).
 */
export function __peekServerStateForTests(): { port: number } | undefined {
  return state ? { port: state.port } : undefined;
}
