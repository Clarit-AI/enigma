import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #68 AC5: comments and docs that claim SessionStart surfaces the
// recovery signal are corrected. The shape of the correction lives in
// `src/hooks/session-start.ts`'s source code, in `docs/api-contracts.md` §5,
// in `docs/architecture.md` ADR-004, and in the user-facing skill text
// `plugins/enigma/skills/enigma/SKILL.md`. This test pins the four of them
// together — same pattern as `test/unit/ci-workflow.test.ts` (CI workflow
// assertions) and `test/unit/reason-field-surfaces.test.ts` (registry of
// every file that touches `RequestNameResult`). A future edit that drifts
// any of these back toward "SessionStart surfaces the recovery signal"
// fails here on purpose, so the dead branch can't be silently re-introduced.

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const apiContracts = readFileSync(join(REPO_ROOT, 'docs/api-contracts.md'), 'utf8');
const architecture = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
const skill = readFileSync(join(REPO_ROOT, 'plugins/enigma/skills/enigma/SKILL.md'), 'utf8');
const sessionStartSrc = readFileSync(join(REPO_ROOT, 'src/hooks/session-start.ts'), 'utf8');

describe('docs no longer claim SessionStart surfaces the recovery signal (Issue #68 AC5)', () => {
  describe('docs/api-contracts.md', () => {
    it('names the SessionStart output explicitly and points at enigma_doctor for the recovery signal', () => {
      // The §5 SessionStart line must spell out what the hook DOES emit
      // (registered names + sticky default + manifest gaps) and must name
      // the only place the recovery signal actually lives. A future edit
      // that adds a "pending request" mention back to this line fails here.
      expect(apiContracts).toMatch(/SessionStart[\s\S]{0,400}?never the recovery signal/i);
      expect(apiContracts).toMatch(/enigma_doctor/i);
    });

    it('does not say SessionStart reports "pending unconfirmed" requests', () => {
      expect(apiContracts).not.toMatch(/SessionStart[\s\S]{0,400}?pending unconfirmed/);
    });
  });

  describe('docs/architecture.md', () => {
    it('ADR-004 explicitly notes the SessionStart / request-store separation', () => {
      // ADR-004 must say SessionStart is intentionally separate from the
      // request store (which lives in the MCP process) and point at
      // enigma_doctor for the recovery signal. A future edit that
      // removes this caveat re-introduces the drift #68 corrected.
      const adr004 = architecture.match(/## ADR-004[\s\S]*?(?=\n## |\n*$)/);
      expect(adr004).not.toBeNull();
      expect(adr004![0]).toMatch(/SessionStart[\s\S]{0,600}?(recovery signal|RequestStore[\s\S]{0,200}?MCP)/i);
      expect(adr004![0]).toMatch(/enigma_doctor/);
    });

    it('does not say SessionStart surfaces the recovery signal without the separation caveat', () => {
      const adr004 = architecture.match(/## ADR-004[\s\S]*?(?=\n## |\n*$)/);
      expect(adr004).not.toBeNull();
      // The exact false-claim wording from the dead-code era, in either
      // order: "SessionStart" + "same recovery signal" on the same line,
      // OR "SessionStart" + "surfaces the recovery signal" anywhere.
      expect(adr004![0]).not.toMatch(/SessionStart.*same recovery signal/);
      expect(adr004![0]).not.toMatch(/SessionStart.*surfaces? the recovery signal/);
    });
  });

  describe('plugins/enigma/skills/enigma/SKILL.md', () => {
    it('attributes the pending-unconfirmed-requests output to enigma_doctor, not SessionStart', () => {
      // The skill text must point at enigma_doctor for the recovery
      // signal. A future edit that re-attaches the signal to SessionStart
      // in this user-facing doc fails here.
      const doctorRow = skill.match(/enigma_doctor[\s\S]{0,400}/);
      expect(doctorRow).not.toBeNull();
      expect(doctorRow![0]).toMatch(/pending|recovery|unconfirmed/i);
    });

    it('does not say SessionStart surfaces the recovery signal in any of its lines', () => {
      // Find any line containing "SessionStart" and assert none of them
      // claim the recovery signal is surfaced there. Lines that contain
      // a NEGATION ("does not surface", "no longer", "doesn't", "never",
      // "intentionally separate", "instead") are explicitly allowed —
      // the doc must be able to disclaim the wrong attribution to
      // SessionStart without this test misfiring.
      for (const line of skill.split('\n')) {
        if (!/SessionStart/i.test(line)) continue;
        const claimPattern = /recovery signal|unconfirmed|pending request|outcome you may not have seen/i;
        const negationPattern = /\b(does not|doesn't|do not|never|no longer|intentionally separate|not surface|instead)\b/i;
        if (claimPattern.test(line) && !negationPattern.test(line)) {
          throw new Error(`SKILL.md line claims SessionStart surfaces the recovery signal: ${line}`);
        }
      }
    });
  });

  describe('src/hooks/session-start.ts', () => {
    it('does not import RequestStore (the dead branch it used to call)', () => {
      // Regression guard for the dead code removal itself: if a future
      // edit ever tries to wire SessionStart back into the request
      // store, the import reappears and this test fails.
      expect(sessionStartSrc).not.toMatch(/from\s+['"][^'"]*request\/store/);
    });

    it('does not call RequestStore.listUnconsumedFulfilled()', () => {
      expect(sessionStartSrc).not.toMatch(/listUnconsumedFulfilled\s*\(/);
    });

    it('does not include the literal "pending unconfirmed request" line in the rendered output', () => {
      expect(sessionStartSrc).not.toMatch(/pending unconfirmed request/);
    });
  });
});
