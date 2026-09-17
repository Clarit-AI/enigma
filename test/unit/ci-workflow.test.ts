import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('.github/workflows/ci.yml (AC4)', () => {
  it('triggers on pull_request', () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
  });

  it('triggers on push to main', () => {
    expect(workflow).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it('runs lint', () => {
    expect(workflow).toMatch(/run:\s*npm run lint/);
  });

  it('runs typecheck', () => {
    expect(workflow).toMatch(/run:\s*npm run typecheck/);
  });

  it('runs the test suite', () => {
    expect(workflow).toMatch(/run:\s*npm test/);
  });

  it('runs the leak fence', () => {
    expect(workflow).toMatch(/run:\s*npm run leak-fence/);
  });

  it('runs npm audit at high severity', () => {
    expect(workflow).toMatch(/run:\s*npm audit --audit-level=high/);
  });

  it('runs the build', () => {
    expect(workflow).toMatch(/run:\s*npm run build/);
  });

  it('checks committed dist bundles for drift after building', () => {
    expect(workflow).toMatch(/git status --porcelain plugins\/enigma\/dist/);
  });

  it('exercises the toolchain guard by running a gate command without npm ci first (Issue #29)', () => {
    expect(workflow).toMatch(/toolchain-guard:/);
    expect(workflow).toMatch(/Verify gate commands refuse to run without npm ci/);
  });
});
