// Pins for the AC clauses that don't naturally fall out of behavioral
// tests: the "no child_process" rule (AC10) and the doc claims
// (AC12 — PRD D1.1 / S1.4, ADR-003 identity paragraph). These read source
// and docs directly so a regression that drops the rule or the doc text
// fails the test, not the user.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('Issue #67 AC10: src/core/project.ts has no child_process import', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/core/project.ts'), 'utf8');

  it('does not import from "node:child_process"', () => {
    expect(source).not.toMatch(/from\s+['"]node:child_process['"]/);
  });

  it('does not import from "child_process"', () => {
    // Bare (no protocol) form, in case anyone writes it that way.
    expect(source).not.toMatch(/from\s+['"]child_process['"]/);
  });

  it('does not require("child_process")', () => {
    expect(source).not.toMatch(/require\(['"]child_process['"]\)/);
  });
});

describe('Issue #67 AC12: doc claims', () => {
  const prd = readFileSync(join(REPO_ROOT, 'PRD.md'), 'utf8');
  const architecture = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');

  it('PRD D1.1 describes the identity vs location split', () => {
    // The D1.1 line must mention both halves — identity (canonical, common
    // git dir, realpath, the hashed key) and location (lexical worktree
    // root, used for project-local files).
    expect(prd).toMatch(/^- D1\.1 .*$/m);
    const d11 = prd.match(/^- D1\.1 .*$/m)?.[0] ?? '';
    expect(d11).toMatch(/identity/i);
    expect(d11).toMatch(/location|worktree/i);
  });

  it('PRD S1.4 is the worktree-shares-scope acceptance scenario', () => {
    expect(prd).toMatch(/^- S1\.4 /m);
    const s14 = prd.match(/^- S1\.4 .*$/m)?.[0] ?? '';
    expect(s14).toMatch(/worktree/i);
    expect(s14).toMatch(/scope/i);
  });

  it('ADR-003 has a clearly-headed identity paragraph', () => {
    // Look for the ADR-003 section, then assert there's a sub-heading
    // that names "identity" inside it (and that it lives before the next
    // ADR- header, so it can't be sneaking into the wrong section).
    const adr3Match = architecture.match(/## ADR-003[\s\S]*?(?=\n## ADR-|$)/);
    expect(adr3Match, 'ADR-003 section must exist').toBeTruthy();
    const adr3 = adr3Match![0];
    // The header uses "Project identity vs location" — Issue #67 specifically.
    expect(adr3).toMatch(/### .*identity.*location.*Issue #67/i);
    // Body content must cover both halves of the split.
    expect(adr3).toMatch(/findRepoIdentityPath/);
    expect(adr3).toMatch(/findProjectPath/);
    expect(adr3).toMatch(/no child process|pure fs/i);
  });
});
