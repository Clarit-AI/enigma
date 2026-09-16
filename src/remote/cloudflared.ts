// Spawns a cloudflared quick tunnel and scrapes its public URL out of
// stderr — a scraping contract against someone else's tool output, so this
// is bounded and defensive on every axis: a hard deadline on finding the
// URL at all, a cap on how much stderr we ever hold in memory, and every
// exit path (timeout, early process death, spawn failure) rejects with a
// name-only EnigmaError rather than hanging or throwing raw.
import { spawn } from 'node:child_process';
import { EnigmaError } from '../core/errors.js';
import type { RemoteTunnel } from './types.js';

/** AC: "parses the URL from stderr within 20 s" (docs/api-contracts.md, Issue #12). */
const URL_TIMEOUT_MS = 20_000;
/** Defensive cap so a misbehaving process can't grow this buffer without bound; the URL appears in cloudflared's first few lines of output in practice. */
const MAX_STDERR_BYTES = 64 * 1024;
/** Matches the whole `https://<slug>.trycloudflare.com` form; never matches on a partial/split line still mid-arrival because it requires the full suffix to already be present in the accumulated buffer. */
const TRYCLOUDFLARE_PATTERN = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/;

function remoteUnavailable(detail: string): EnigmaError {
  return new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message: `cloudflared: ${detail}` });
}

/** Starts `cloudflared tunnel --url <targetUrl>` and resolves once its public URL is known. Rejects (never hangs past `URL_TIMEOUT_MS`) if the URL never appears. */
export function startCloudflaredTunnel(targetUrl: string): Promise<RemoteTunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', targetUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
    // A ref'd child handle keeps this process's event loop alive by itself;
    // this tunnel's lifetime is governed by the request it belongs to
    // (registerActiveTunnel/index.ts), not by whether anything else is
    // still running, so it must never be what holds the process open
    // (Tech Lead ruling on PR #35, round 2).
    child.unref();

    let stderrBuf = '';
    let settled = false;
    let stopped = false;
    let unexpectedExitResolve: (() => void) | undefined;
    const unexpectedExit = new Promise<void>((res) => {
      unexpectedExitResolve = res;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(remoteUnavailable(`timed out waiting for a trycloudflare.com URL after ${URL_TIMEOUT_MS}ms`));
    }, URL_TIMEOUT_MS);
    timer.unref();

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(remoteUnavailable('failed to start (is it on PATH?)'));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > MAX_STDERR_BYTES) stderrBuf = stderrBuf.slice(-MAX_STDERR_BYTES);

      const match = TRYCLOUDFLARE_PATTERN.exec(stderrBuf);
      if (!match) return;

      settled = true;
      clearTimeout(timer);

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        killer.unref();
      };

      resolve({
        url: match[0],
        binary: 'cloudflared',
        stop,
        waitForUnexpectedExit: () => unexpectedExit,
      });
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(remoteUnavailable(`exited before establishing a tunnel (code ${code ?? 'unknown'})`));
        return;
      }
      if (!stopped) unexpectedExitResolve?.();
    });
  });
}
