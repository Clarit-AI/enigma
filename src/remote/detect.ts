// Bounded, non-prompting presence checks for the two supported tunnel
// binaries. Neither present is the common case (a fresh Mac, any Linux CI
// runner) — this must resolve quickly either way, never hang. `--version`
// and `version` are the fast, non-interactive probes for these two CLIs
// (mirrors the existing `binaryStatus` probe in mcp/tools/doctor.ts and the
// bounded-exec precedent in storage/depositories/onepassword.ts).
import { execFile } from 'node:child_process';

const DETECT_TIMEOUT_MS = 2_000;

function checkBinary(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: DETECT_TIMEOUT_MS, maxBuffer: 4096 }, (error) => resolve(!error));
  });
}

export function detectCloudflared(): Promise<boolean> {
  return checkBinary('cloudflared', ['--version']);
}

export function detectTailscale(): Promise<boolean> {
  return checkBinary('tailscale', ['version']);
}
