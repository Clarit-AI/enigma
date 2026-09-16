// Non-localhost HTTP binding policy (ADR-005, harvested from ClawVault). Enigma
// is local-only; this refuses to bind the request/reveal server to a plain-HTTP
// non-loopback address unless the host is clearly Tailscale-associated or the
// caller explicitly overrides (V2 remote-access work, Issue #12, opts in per request).
import { isIP } from 'node:net';

const LOCALHOST_ADDRESSES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalhostBinding(host: string): boolean {
  return LOCALHOST_ADDRESSES.has(host);
}

/** Tailscale CGNAT range (100.64.0.0/10) or a MagicDNS `.ts.net` name. No network calls. */
export function isTailscaleHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower.endsWith('.ts.net')) return true;

  if (isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts as [number, number, number, number];
  return a === 100 && b >= 64 && b <= 127;
}

export interface InsecureHttpPolicy {
  allow: boolean;
  reason: 'localhost' | 'tailscale' | 'override' | 'refuse';
}

export function decideInsecureHttpPolicy(host: string, allowOverride: boolean): InsecureHttpPolicy {
  if (isLocalhostBinding(host)) return { allow: true, reason: 'localhost' };
  if (isTailscaleHost(host)) return { allow: true, reason: 'tailscale' };
  if (allowOverride) return { allow: true, reason: 'override' };
  return { allow: false, reason: 'refuse' };
}
