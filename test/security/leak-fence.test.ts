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

/**
 * Runs the fence as a subprocess. `stdio: 'pipe'` is passed explicitly — Node's
 * execFileSync otherwise forwards a failing child's stderr straight to this
 * process's stderr by default, which would print the negative fixtures' expected
 * `leak-fence: FAILED` lines into an otherwise-green `npm test` run.
 */
function runLeakFence(): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('leak-fence', () => {
  it('passes on the stub tree with no fixture present', () => {
    expect(runLeakFence().code).toBe(0);
  });

  it('does not trip on Promise.resolve( alone', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-promise-resolve__.ts');
    writeFileSync(fixture, 'export function settled<T>(value: T): Promise<T> { return Promise.resolve(value); }\n');
    expect(runLeakFence().code).toBe(0);
  });

  it('does not trip on Promise . resolve ( with intervening whitespace', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-promise-resolve-spaced__.ts');
    writeFileSync(
      fixture,
      'export function settled<T>(value: T): Promise<T> { return Promise . resolve (value); }\n',
    );
    expect(runLeakFence().code).toBe(0);
  });

  it('does not trip on a Promise-executor parameter named resolve', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-executor-param__.ts');
    writeFileSync(
      fixture,
      'export function settled<T>(value: T): Promise<T> { return new Promise((resolve, reject) => resolve(value)); }\n',
    );
    expect(runLeakFence().code).toBe(0);
  });

  it('fails when a fixture file under src/mcp/ contains a real resolveSecret( call', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-resolve-secret__.ts');
    writeFileSync(fixture, 'export function read(name: string) { return resolveSecret(name, {}); }\n');
    expect(runLeakFence().code).toBe(1);
  });

  it('fails when a fixture file under src/mcp/ contains a depository-style .resolve( call', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-depository-resolve__.ts');
    writeFileSync(fixture, 'export function read(depository: { resolve(ref: string): Promise<string> }, ref: string) { return depository.resolve(ref); }\n');
    expect(runLeakFence().code).toBe(1);
  });

  it('passes and reports an allowlisted fixture with a non-empty reason', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-allowed__.ts');
    writeFileSync(
      fixture,
      '// enigma:leak-fence-allow: reveal route intentionally resolves\nexport function read(name: string) { return resolveSecret(name, {}); }\n',
    );
    const result = runLeakFence();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('__leak-fence-fixture-allowed__.ts');
  });

  it('fails when the allow marker has an empty reason', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-empty-reason__.ts');
    writeFileSync(
      fixture,
      '// enigma:leak-fence-allow:\nexport function read(name: string) { return resolveSecret(name, {}); }\n',
    );
    expect(runLeakFence().code).toBe(1);
  });

  it('catches resolveSecret( with intervening whitespace via the regex match', () => {
    fixture = join(REPO_ROOT, 'src/mcp/__leak-fence-fixture-whitespace__.ts');
    writeFileSync(fixture, 'export function read(name: string) { return resolveSecret  (name, {}); }\n');
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
        'export function read(name: string) { return resolveSecret(name, {}); }',
        '',
      ].join('\n'),
    );
    expect(runLeakFence().code).toBe(1);
  });

  it('would still catch the reveal route call shape if its allow marker were removed (sanity check, fixture-only)', () => {
    // Mirrors src/web/routes/reveal.ts's real call — `resolveSecret(name, { scope, cwd, actor, auditOp })`
    // — minus its allow marker, proving the fence still gates that exact shape without editing the real file.
    fixture = join(REPO_ROOT, 'src/web/__leak-fence-fixture-reveal-shape__.ts');
    writeFileSync(
      fixture,
      "export async function reveal(name: string, scope: string) { return resolveSecret(name, { scope, cwd: process.cwd(), actor: 'user', auditOp: 'reveal' }); }\n",
    );
    expect(runLeakFence().code).toBe(1);
  });
});
