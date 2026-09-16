import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/leak-fence.mjs', import.meta.url));
const REPO_ROOT = dirname(dirname(SCRIPT));

let fixture: string | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture, { force: true });
  fixture = undefined;
});

function runLeakFence(): { code: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '' };
  }
}

describe('leak-fence', () => {
  it('fails when a fixture file under src/mcp/ contains resolve(', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-bad__.ts');
    writeFileSync(fixture, 'export function read(name: string) { return resolve(name); }\n');
    expect(runLeakFence().code).toBe(1);
  });

  it('passes on the stub tree once the offending fixture is removed', () => {
    expect(runLeakFence().code).toBe(0);
  });

  it('passes and reports an allowlisted fixture with a non-empty reason', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-allowed__.ts');
    writeFileSync(
      fixture,
      '// enigma:leak-fence-allow: reveal route intentionally resolves\nexport function read(name: string) { return resolve(name); }\n',
    );
    const result = runLeakFence();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('__leak-fence-fixture-allowed__.ts');
  });

  it('fails when the allow marker has an empty reason', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-empty-reason__.ts');
    writeFileSync(
      fixture,
      '// enigma:leak-fence-allow:\nexport function read(name: string) { return resolve(name); }\n',
    );
    expect(runLeakFence().code).toBe(1);
  });

  it('catches resolve( with intervening whitespace via the regex match', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-whitespace__.ts');
    writeFileSync(fixture, 'export function read(name: string) { return resolve  (name); }\n');
    expect(runLeakFence().code).toBe(1);
  });

  it('does not honor an allow marker placed on line 6 or later', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-late-marker__.ts');
    writeFileSync(
      fixture,
      [
        '// line 1',
        '// line 2',
        '// line 3',
        '// line 4',
        '// line 5',
        '// enigma:leak-fence-allow: too late to count',
        'export function read(name: string) { return resolve(name); }',
        '',
      ].join('\n'),
    );
    expect(runLeakFence().code).toBe(1);
  });
});
