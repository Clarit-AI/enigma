#!/usr/bin/env node
// Static scan: fails if `resolve(` is reachable from src/mcp/** or src/web/** (ADR-001).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW_PREFIX = '// enigma:leak-fence-allow:';
const LEAK_PATTERN = 'resolve(';
const SCAN_DIRS = ['src/mcp', 'src/web'];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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
    for (const file of walk(dir)) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes(LEAK_PATTERN)) continue;

      const marker = checkAllowlist(content.split('\n'));
      if (marker?.allowed) {
        allowlisted.push({ file, reason: marker.reason });
      } else if (marker && !marker.allowed) {
        console.error(`leak-fence: ${file} has an empty leak-fence-allow marker (reason required)`);
        failed = true;
      } else {
        console.error(`leak-fence: ${file} references ${LEAK_PATTERN}`);
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
