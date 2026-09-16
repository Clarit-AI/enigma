// `tailscale serve` path (D2.6, config.remote:"tailscale"). Runs `serve` in
// the foreground (never `--bg`) so it is a direct child of this process —
// the same shape as cloudflared.ts — which is what lets an unexpected exit
// be observed the instant it happens, rather than needing to poll
// `tailscale serve status` for the life of every request.
import { execFile, spawn } from 'node:child_process';
import { EnigmaError } from '../core/errors.js';
import type { RemoteTunnel } from './types.js';

const STATUS_TIMEOUT_MS = 10_000;
const OFF_TIMEOUT_MS = 10_000;
/** How long a freshly spawned `serve` gets to fail fast (bad tailnet ACL, no HTTPS cert, etc.) before it is trusted as running. */
const START_GRACE_MS = 3_000;
const SERVE_PORT = 443;

interface TailscaleStatus {
  Self?: { DNSName?: string };
}

function remoteUnavailable(detail: string): EnigmaError {
  return new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message: `tailscale: ${detail}` });
}

function runTailscale(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** This node's MagicDNS name (trailing dot stripped) — the AC's "URL derived from `tailscale status --json`". */
async function selfDnsName(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await runTailscale(['status', '--json'], STATUS_TIMEOUT_MS));
  } catch {
    throw remoteUnavailable('"tailscale status --json" failed (is tailscaled running and this node logged in?)');
  }

  let parsed: TailscaleStatus;
  try {
    parsed = JSON.parse(stdout) as TailscaleStatus;
  } catch {
    throw remoteUnavailable('"tailscale status --json" returned output that could not be parsed');
  }

  const dnsName = parsed.Self?.DNSName;
  if (!dnsName) throw remoteUnavailable('"tailscale status --json" has no DNSName for this node');
  return dnsName.replace(/\.+$/, '');
}

function offBestEffort(): void {
  void runTailscale(['serve', `--https=${SERVE_PORT}`, 'off'], OFF_TIMEOUT_MS).catch(() => {
    // Best-effort cleanup only; the foreground `serve` process being killed
    // already tears down the mapping in the common case.
  });
}

export async function startTailscaleServe(port: number): Promise<RemoteTunnel> {
  const dnsName = await selfDnsName();
  const target = `http://127.0.0.1:${port}`;

  return new Promise((resolve, reject) => {
    const child = spawn('tailscale', ['serve', `--https=${SERVE_PORT}`, target], { stdio: 'ignore' });
    // See cloudflared.ts: this tunnel's lifetime is governed by the request
    // it belongs to, not by whether it happens to be the only thing left
    // running, so it must never itself hold this process's event loop open
    // (Tech Lead ruling on PR #35, round 2).
    child.unref();

    let settled = false;
    let stopped = false;
    let unexpectedExitResolve: (() => void) | undefined;
    const unexpectedExit = new Promise<void>((res) => {
      unexpectedExitResolve = res;
    });

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killer.unref();
      offBestEffort();
    };

    const graceTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ url: `https://${dnsName}`, binary: 'tailscale', stop, waitForUnexpectedExit: () => unexpectedExit });
    }, START_GRACE_MS);
    graceTimer.unref();

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      reject(remoteUnavailable('failed to start (is it on PATH?)'));
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(graceTimer);
        reject(remoteUnavailable(`exited before serving (code ${code ?? 'unknown'})`));
        return;
      }
      if (!stopped) unexpectedExitResolve?.();
    });
  });
}
