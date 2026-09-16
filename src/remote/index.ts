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

  const available = await detectBinary(binary);
  if (!available) {
    const hint = INSTALL_HINTS[binary];
    if (preference === 'required') throw new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message: hint });
    return { note: `Remote access unavailable — ${hint}. Used the local link instead.` };
  }

  try {
    const tunnel = await startTunnel(binary, port);
    return { tunnel };
  } catch (err) {
    const reason = err instanceof EnigmaError ? err.message : `${binary} failed to start`;
    if (preference === 'required') {
      throw err instanceof EnigmaError ? err : new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message: reason });
    }
    return { note: `Remote access unavailable — ${reason}. Used the local link instead.` };
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
    if (entry) entry.note = `Remote access via ${tunnel.binary} was lost during this request; the local link still works.`;
  });
}

/** The active tunnel's public origin for `requestId`, or `undefined` if none is up — used by the request-form route to decide whether to render a QR code. */
export function getActiveRemoteUrl(requestId: string): string | undefined {
  return active.get(requestId)?.tunnel?.url;
}

/** Reads and clears the informational note (if any) for `requestId` — call once, after the request has settled. Names the remote mechanism only, never a URL or value (S2.3, the leak criterion). */
export function takeRemoteNote(requestId: string): string | undefined {
  const entry = active.get(requestId);
  active.delete(requestId);
  return entry?.note;
}
