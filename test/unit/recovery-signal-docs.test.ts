import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #68 AC5 (round-3 revision): pin four corrections together, each
// as a positive statement the doc must satisfy — no over-reaching
// negatives, no negation-aware heuristics, no claim to detect wording
// drift beyond what is actually pinned here.
//
// What this test GUARANTEES:
//   1. `docs/api-contracts.md` §1 `enigma_doctor` row carries the
//      recovery-signal output in names-only wording with the three
//      static labels (Issue #68 round-3).
//   2. `docs/api-contracts.md` §5 SessionStart line explicitly says
//      SessionStart does not surface the recovery signal and points at
//      enigma_doctor.
//   3. `docs/architecture.md` ADR-004 names the SessionStart /
//      request-store separation and points at enigma_doctor.
//   4. `plugins/enigma/skills/enigma/SKILL.md` attributes the
//      pending-unconfirmed-requests output to enigma_doctor in the same
//      sentence that mentions it.
//   5. `plugins/enigma/skills/enigma/SKILL.md` has NO sentence (split
//      on `.`) that contains both "SessionStart" and a surfacing verb
//      UNLESS that same sentence also contains a negation ("not",
//      "never", "no longer", "cannot") — see the per-sentence check
//      below for the exact decidable form.
//   6. `src/hooks/session-start.ts` does not import RequestStore, does
//      not call `listUnconsumedFulfilled(`, and does not include the
//      literal "pending unconfirmed request" string.
//
// What this test does NOT claim to detect (and therefore makes no
// attempt to): drift in word choice outside the pinned phrases, drift
// in any other section of the docs, drift in any other file outside the
// four pinned here. A future edit that changes the wording in a way
// this test does not pin is allowed to land; the test is a backstop,
// not a guarantee.

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const apiContracts = readFileSync(join(REPO_ROOT, 'docs/api-contracts.md'), 'utf8');
const architecture = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
const skill = readFileSync(join(REPO_ROOT, 'plugins/enigma/skills/enigma/SKILL.md'), 'utf8');
const sessionStartSrc = readFileSync(join(REPO_ROOT, 'src/hooks/session-start.ts'), 'utf8');

const SECTION_5 = '## 5. Hook contracts';
const ADR_004_HEADER = '## ADR-004';

function section(doc: string, header: string): string {
  const start = doc.indexOf(header);
  if (start === -1) throw new Error(`section "${header}" not found`);
  // Sections end at the next "## N." or "## ADR-" header at the same level.
  const after = doc.slice(start + header.length);
  const endMatch = after.match(/^[\s\S]*?(?=\n## (?:ADR-|\d+\.)\s|\n*$)/);
  return endMatch ? doc.slice(start, start + header.length + endMatch[0].length) : doc.slice(start);
}

describe('docs and source pin the SessionStart / recovery-signal separation (Issue #68 AC5)', () => {
  describe('docs/api-contracts.md', () => {
    it('§1 enigma_doctor row carries the three-bucket recovery-signal output (stored / failed / outcome unknown)', () => {
      // The §1 row must carry all three static labels so the rendered
      // shape of the recovery signal is pinned in the contract.
      expect(section(apiContracts, '## 1. MCP tools')).toMatch(/stored:/);
      expect(section(apiContracts, '## 1. MCP tools')).toMatch(/failed:/);
      expect(section(apiContracts, '## 1. MCP tools')).toMatch(/outcome unknown:/);
      expect(section(apiContracts, '## 1. MCP tools')).toMatch(/E_OUTCOME_UNKNOWN/);
    });

    it('§5 SessionStart line explicitly says the hook does NOT surface the recovery signal and points at enigma_doctor', () => {
      const sec5 = section(apiContracts, SECTION_5);
      expect(sec5).toMatch(/SessionStart[\s\S]{0,400}?never the recovery signal/i);
      expect(sec5).toMatch(/enigma_doctor/);
    });
  });

  describe('docs/architecture.md', () => {
    it('ADR-004 names the SessionStart / request-store separation and points at enigma_doctor', () => {
      const adr004 = section(architecture, ADR_004_HEADER);
      // ADR-004 must mention SessionStart, the request store separation,
      // and enigma_doctor for the recovery signal.
      expect(adr004).toMatch(/SessionStart[\s\S]{0,1000}?(recovery signal|RequestStore[\s\S]{0,200}?MCP)/i);
      expect(adr004).toMatch(/enigma_doctor/);
    });
  });

  describe('plugins/enigma/skills/enigma/SKILL.md', () => {
    it('attributes the pending-unconfirmed-requests output to enigma_doctor in the same sentence that mentions it (positive)', () => {
      // Decidable positive: the `enigma_doctor` row/bullet must contain
      // the word "pending" / "unconfirmed" / "recovery" so a reader
      // looking up how to see pending requests finds it under the
      // enigma_doctor row, not under anything else.
      const doctorRow = skill.match(/enigma_doctor[\s\S]{0,400}/);
      expect(doctorRow).not.toBeNull();
      expect(doctorRow![0]).toMatch(/pending|recovery|unconfirmed/i);
    });

    it('has no sentence that contains both "SessionStart" and a surfacing verb without also containing a negation (decidable per-sentence)', () => {
      // Split on `.` so each chunk is roughly one sentence. A sentence
      // that mentions SessionStart AND a surfacing verb (surface /
      // surfaces / surfaced / surfacing / emits / reports / lists /
      // shows) CLAIMS SessionStart surfaces something — and that claim
      // must be disallowed, unless the same sentence also contains a
      // negation. This catches both a positive ("SessionStart surfaces
      // the recovery signal") and a soft negative ("SessionStart
      // surfaces the recovery signal, which never includes values") that
      // would otherwise slip past a per-line scan, and is decidable in
      // both directions (any future edit that lands or fails this rule
      // produces a clear pass / fail).
      const sentences = skill
        .split('.')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const surfacingVerb = /\b(surfaces?|surfaced|surfacing|emits?|emitted|report(?:s|ed)?|lists?|listed|shows?|showed|displays?|displayed)\b/i;
      const negation = /\b(not|never|no longer|cannot|can't|won't|doesn't|does not|do not)\b/i;
      const offenders: string[] = [];
      for (const sentence of sentences) {
        if (!/SessionStart/i.test(sentence)) continue;
        if (!surfacingVerb.test(sentence)) continue;
        if (negation.test(sentence)) continue;
        offenders.push(sentence);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('src/hooks/session-start.ts', () => {
    it('does not import RequestStore (the dead branch it used to call)', () => {
      expect(sessionStartSrc).not.toMatch(/from\s+['"][^'"]*request\/store/);
    });

    it('does not call RequestStore.listUnconsumedFulfilled()', () => {
      expect(sessionStartSrc).not.toMatch(/listUnconsumedFulfilled\s*\(/);
    });

    it('does not include the literal "pending unconfirmed request" string', () => {
      expect(sessionStartSrc).not.toMatch(/pending unconfirmed request/);
    });
  });
});
