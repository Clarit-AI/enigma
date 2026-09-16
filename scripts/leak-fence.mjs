#!/usr/bin/env node
// Static scan: fails if a sanctioned value-returning call shape is reachable from the
// scanned directories (ADR-001) — `resolveSecret(` (the storage layer's value-returning
// call) or a depository-style `.resolve(` method call, excluding `Promise.resolve(`.
// This is a backstop, not a guarantee — it catches obvious textual patterns, not every
// way a secret value could leak. Review and the runtime boundary are the real defenses.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW_PREFIX = '// enigma:leak-fence-allow:';
const LEAK_PATTERN = /\bresolveSecret\s*\(|(?<!\bPromise\s*)\.\s*resolve\s*\(/;
// src/hooks is scanned too: the tripwire hook legitimately resolves a value (with
// its own allow marker, same as the reveal route below), but session-start.ts and
// read-guard.ts have no legitimate reason to ever do so — an unscanned directory
// here would be an unguarded one for exactly the code that's meant to be the
// backstop when everything else fails.
const SCAN_DIRS = ['src/mcp', 'src/web', 'src/hooks'];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function checkAllowlist(lines) {
  for (const rawLine of lines.slice(0, 5)) {
    const line = rawLine.trim();
    if (line.startsWith(ALLOW_PREFIX)) {
      const reason = line.slice(ALLOW_PREFIX.length).trim();
      return reason.length > 0 ? { allowed: true, reason } : { allowed: false, reason: '' };
    }
  }
  return null;
}

function main() {
  const allowlisted = [];
  let failed = false;

  for (const dir of SCAN_DIRS) {
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    } catch {
      console.error(`leak-fence: scan directory ${dir} does not exist`);
      process.exit(1);
    }

    for (const file of walk(dir)) {
      const content = readFileSync(file, 'utf8');
      if (!LEAK_PATTERN.test(content)) continue;

      const marker = checkAllowlist(content.split('\n'));
      if (marker?.allowed) {
        allowlisted.push({ file, reason: marker.reason });
      } else if (marker && !marker.allowed) {
        console.error(`leak-fence: ${file} has an empty leak-fence-allow marker (reason required)`);
        failed = true;
      } else {
        console.error(`leak-fence: ${file} matches ${LEAK_PATTERN}`);
        failed = true;
      }
    }
  }

  for (const { file, reason } of allowlisted) {
    console.log(`leak-fence: allowlisted ${file} — ${reason}`);
  }

  if (failed) {
    console.error('leak-fence: FAILED');
    process.exit(1);
  }
  console.log('leak-fence: OK');
}

main();
