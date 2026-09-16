// Shared types for the remote-access module (Issue #12, D2.6, ADR-005).
export type RemoteBinary = 'cloudflared' | 'tailscale';

/**
 * Resolved from the `remote` MCP/CLI parameter (docs/api-contracts.md §1/§3):
 * absent/false → local only; `true` → remote or an honest refusal, never a
 * silent localhost downgrade (the PR #31 finding this Issue closes);
 * `"prefer"` → best-effort remote, falling back to local and saying so.
 */
export type RemotePreference = 'required' | 'prefer' | 'none';

export interface RemoteTunnel {
  /** The tunnel's public origin, e.g. `https://random-words.trycloudflare.com` or `https://host.tailnet.ts.net`. Never combined with a request id anywhere but the elicitation message and the local page (S2.3/leak criterion). */
  url: string;
  binary: RemoteBinary;
  /** Stops the tunnel and releases its process/mapping. Idempotent. */
  stop(): void;
  /** Resolves once the tunnel ends on its own (the process died, or the mapping dropped) — never resolves if `stop()` caused the end. Used to report S2.3 ("tunnel loss by name only"). */
  waitForUnexpectedExit(): Promise<void>;
}

/** The result of attempting remote access once, before it is tied to any particular request id. */
export interface RemoteAttempt {
  tunnel?: RemoteTunnel;
  /** Set only when `tunnel` is absent because a `"prefer"` attempt fell back to local — names the binary and the reason, never a value. */
  note?: string;
}
