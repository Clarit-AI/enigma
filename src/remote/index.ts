// Orchestrates remote access for one `enigma_request` call (Issue #12,
// D2.6). Split into two phases on purpose:
//
//   1. `attemptRemoteTunnel` — pure with respect to any particular request:
//      detects a binary and, if available, starts it. No request id
//      involved yet, so a `"required"` failure can be reported and the
//      caller can refuse *before* a request is ever created or the user is
//      ever bothered (the honest-refusal rule this Issue closes — PR #31's
//      finding that `remote:true` silently returned a localhost URL).
//   2. `registerActiveTunnel` — ties an already-started attempt to a
//      request id, using only `RequestStore`'s existing public API
//      (`waitForFulfilled`). That promise resolves once fulfilled and
//      rejects once the record expires either way, so tying the tunnel's
//      `stop()` to it is what gives "tunnel dies when the request is
//      fulfilled or expires" without this module ever reaching into
//      request/store.ts's internals.
import { EnigmaError } from '../core/errors.js';
import type { EnigmaConfig } from '../core/config.js';
import { RequestStore } from '../request/store.js';
import { detectCloudflared, detectTailscale } from './detect.js';
import { startCloudflaredTunnel } from './cloudflared.js';
import { startTailscaleServe } from './tailscale.js';
import type { RemoteAttempt, RemoteBinary, RemotePreference, RemoteTunnel } from './types.js';

export type { RemotePreference, RemoteAttempt } from './types.js';

const INSTALL_HINTS: Record<RemoteBinary, string> = {
  cloudflared:
    'cloudflared not found on PATH; install it (e.g. "brew install cloudflared", or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)',
  tailscale: 'tailscale not found on PATH; install it (e.g. "brew install tailscale", or see https://tailscale.com/download)',
};

const TAILSCALE_CONCURRENT_MESSAGE =
  'a remote session is already active for this project — tailscale serve supports only one mapping at a time, and a second one would tear down the first mid-request; wait for it to finish or expire';

/** `remote:true` → required; `remote:"prefer"` → best-effort; absent/false → local only. */
export function resolveRemotePreference(remote: boolean | 'prefer' | undefined): RemotePreference {
  if (remote === true) return 'required';
  if (remote === 'prefer') return 'prefer';
  return 'none';
}

function selectBinary(config: Pick<EnigmaConfig, 'remote'>): RemoteBinary {
  return config.remote === 'tailscale' ? 'tailscale' : 'cloudflared';
}

function detectBinary(binary: RemoteBinary): Promise<boolean> {
  return binary === 'tailscale' ? detectTailscale() : detectCloudflared();
}

/**
 * One `tailscale serve` mapping exists per machine, not per request — a
 * second concurrent `tailscale`-mode request would silently tear down the
 * first request's still-live tunnel mid-submit (Tech Lead ruling on PR #35,
 * round 2). Claimed synchronously, before any `await`, so a second call
 * arriving before the first's detection/spawn even resolves still sees the
 * claim and refuses — this specifically closes the race a plain
 * `active`-map lookup would miss. Released the moment that tunnel truly
 * ends, by any means (`stop()` or an unexpected exit), never before.
 */
let tailscaleClaimed = false;

function startTunnel(binary: RemoteBinary, port: number): Promise<RemoteTunnel> {
  return binary === 'tailscale' ? startTailscaleServe(port) : startCloudflaredTunnel(`http://127.0.0.1:${port}`);
}

/**
 * Resolves to `undefined` when `preference` is `"none"`, or to a
 * `RemoteAttempt` describing what happened. Throws `E_REMOTE_UNAVAILABLE`
 * only when `preference` is `"required"` and remote access could not be
 * established — the caller must not create the request or elicit the user
 * in that case.
 */
export async function attemptRemoteTunnel(
  preference: RemotePreference,
  config: Pick<EnigmaConfig, 'remote'>,
  port: number,
): Promise<RemoteAttempt | undefined> {
  if (preference === 'none') return undefined;

  const binary = selectBinary(config);
  const refuse = (message: string): RemoteAttempt => {
    if (preference === 'required') throw new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message });
    return { note: `Remote access unavailable — ${message}. Used the local link instead.` };
  };

  if (binary === 'tailscale' && tailscaleClaimed) return refuse(TAILSCALE_CONCURRENT_MESSAGE);

  const available = await detectBinary(binary);
  if (!available) return refuse(INSTALL_HINTS[binary]);

  if (binary === 'tailscale') {
    // Re-check after the `await` above: two concurrent calls can both pass
    // the first check before either sets the claim.
    if (tailscaleClaimed) return refuse(TAILSCALE_CONCURRENT_MESSAGE);
    tailscaleClaimed = true;
  }

  try {
    const tunnel = await startTunnel(binary, port);
    if (binary === 'tailscale') {
      const releaseClaim = (): void => {
        tailscaleClaimed = false;
      };
      const originalStop = tunnel.stop;
      tunnel.stop = () => {
        originalStop();
        releaseClaim();
      };
      void tunnel.waitForUnexpectedExit().then(releaseClaim);
    }
    return { tunnel };
  } catch (err) {
    if (binary === 'tailscale') tailscaleClaimed = false;
    const reason = err instanceof EnigmaError ? err.message : `${binary} failed to start`;
    return refuse(reason);
  }
}

interface ActiveEntry {
  tunnel?: RemoteTunnel;
  note?: string;
}

/** How long an entry is kept after its request settles, bounding memory for a caller that never reads the note back (mirrors request/store.ts's own USED_GRACE_MS pattern). */
const CLEANUP_GRACE_MS = 60_000;

const active = new Map<string, ActiveEntry>();

function scheduleCleanup(requestId: string): void {
  const t = setTimeout(() => active.delete(requestId), CLEANUP_GRACE_MS);
  t.unref();
}

/** Ties an already-resolved attempt to `requestId` so the request-form page can find its active tunnel (`getActiveRemoteUrl`) and the tool call can report what happened (`takeRemoteNote`). Call once, right after the request record is created. */
export function registerActiveTunnel(requestId: string, attempt: RemoteAttempt): void {
  const tunnel = attempt.tunnel;
  const note = tunnel ? `Remote access via ${tunnel.binary} was used for this request.` : attempt.note;
  active.set(requestId, { tunnel, note });

  if (!tunnel) {
    void RequestStore.waitForFulfilled(requestId)
      .catch(() => {})
      .finally(() => scheduleCleanup(requestId));
    return;
  }

  void RequestStore.waitForFulfilled(requestId)
    .catch(() => {})
    .finally(() => {
      tunnel.stop();
      scheduleCleanup(requestId);
    });

  void tunnel.waitForUnexpectedExit().then(() => {
    const entry = active.get(requestId);
    if (entry) {
      // Clear the dead tunnel, not just the note: a page reload after this
      // point must stop showing a QR for a link that no longer resolves to
      // anything (Tech Lead ruling on PR #35, round 2) — a link that fails
      // is honest; a link that lies is the thing this Issue exists to stop.
      entry.tunnel = undefined;
      entry.note = `Remote access via ${tunnel.binary} was lost during this request; the local link still works.`;
    }
  });
}

/**
 * The active tunnel's public origin for `requestId`, or `undefined` if none
 * is up (never started, or died unexpectedly) — used by the request-form
 * route to decide whether to render a QR code. A normal `stop()` (the
 * request was fulfilled or expired) also clears this, but that state is
 * never actually observable here: the request-form route already 410s/404s
 * a used or expired record before it would ever reach this call.
 */
export function getActiveRemoteUrl(requestId: string): string | undefined {
  return active.get(requestId)?.tunnel?.url;
}

/** Reads and clears the informational note (if any) for `requestId` — call once, after the request has settled. Names the remote mechanism only, never a URL or value (S2.3, the leak criterion). */
export function takeRemoteNote(requestId: string): string | undefined {
  const entry = active.get(requestId);
  active.delete(requestId);
  return entry?.note;
}

/** Test-only: clears all tracked entries and releases the tailscale concurrency claim, so state never leaks between test files (mirrors RequestStore.__resetForTests). */
export function __resetForTests(): void {
  active.clear();
  tailscaleClaimed = false;
}

function stopAllActiveTunnels(): void {
  for (const entry of active.values()) {
    try {
      entry.tunnel?.stop();
    } catch {
      // One tunnel's stop() throwing must never abandon the rest — that is
      // exactly the leak this handler exists to prevent, now triggered by
      // the handler itself (QA finding on PR #35, round 3).
    }
  }
}

/**
 * Best-effort process-level cleanup — NOT a total guarantee. A `SIGKILL` of
 * this process cannot be caught by anything, ever; that case is out of
 * reach by construction, not an oversight. For the cases that CAN be
 * caught (a graceful exit, `SIGINT`, `SIGTERM`), every spawned tunnel child
 * is `unref()`'d (cloudflared.ts, tailscale.ts) so it can never by itself
 * hold this process's event loop open, and this stops every tracked tunnel
 * before the process actually goes away — closing the gap the round-2
 * review proved by spawning a real `cloudflared`, exiting its Node parent,
 * and watching the child get reparented to PID 1 and keep serving.
 *
 * The `SIGINT`/`SIGTERM` handlers stop tunnels synchronously and then
 * re-raise the same signal at themselves with no listener left (Node's
 * `once` already removed it before invoking this callback), so the
 * process's default disposition — terminate — still applies afterwards.
 * That re-raise, not `process.exit()`, is deliberate: it preserves the
 * exact exit behavior the process would have had with no handler at all,
 * just with tunnels asked to stop first. A tailscale `stop()`'s
 * `serve ... off` call is asynchronous and may not complete before the
 * process actually terminates; the child being killed directly (`SIGTERM`,
 * escalating to `SIGKILL`) is what actually matters and that part is
 * synchronous.
 */
let shutdownHandlersRegistered = false;
export function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  process.once('exit', stopAllActiveTunnels);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // The re-raise must happen no matter what — `finally`, not sequence,
      // is what actually guarantees that (stopAllActiveTunnels already
      // isolates each tunnel's own stop() above, but this is the second,
      // independent layer of protection the round-3 finding asked for: even
      // if something in this handler threw regardless, the process must
      // still terminate normally rather than have Ctrl-C silently stop
      // working).
      try {
        stopAllActiveTunnels();
      } finally {
        process.kill(process.pid, signal);
      }
    });
  }
}

registerShutdownHandlers();
