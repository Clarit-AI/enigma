import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_WEB = fileURLToPath(new URL('../../../src/web', import.meta.url));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('no HTML built by string concatenation in .ts (style guide)', () => {
  it('no .ts file under src/web contains a literal <html tag', () => {
    expect(statSync(SRC_WEB).isDirectory()).toBe(true);
    const offenders = walk(SRC_WEB).filter((file) => /<html/i.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
