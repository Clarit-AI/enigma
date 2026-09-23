import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #38: `scripts/leak-fence.mjs` matches value-returning CALL shapes; it
// cannot see a plain field assignment, so it would stay green if
// `RequestNameResult.reason` were ever widened to carry a value (see that
// interface's doc comment in src/request/store.ts). Teaching the fence
// itself to reason about field provenance was considered and rejected as
// brittle: `reason` is an extremely common field name elsewhere in this
// codebase (network-policy allow/deny reasons, depository-unavailable
// reasons, the free-text request/reveal justification on RequestRecord) for
// purposes that have nothing to do with this concern, so a rule that just
// matches the token `reason` would either misfire constantly or need the
// same brittle "is this RHS safe" reasoning the leak-fence itself avoids.
//
// This test is the chosen alternative: a registry of every file that
// touches RequestNameResult, kept honest two ways —
//   1. a file that references RequestNameResult but isn't in SURFACES fails
//      the first test below, so a brand-new surface can't go unregistered;
//   2. for files known to construct RequestNameResult, the exact set of
//      `reason:` assignment lines is pinned as a golden snapshot, so a new
//      or *changed* assignment inside an ALREADY-registered file — the
//      motivating scenario in Issue #38, e.g. populating `reason` from a
//      new error code's message — also fails, and has to be re-reviewed
//      and re-committed to this file on purpose.
//
// What this deliberately does NOT catch: it only recognizes an assignment
// shaped like a multi-property object-literal entry (`reason: <expr>,` on
// its own line, comma-terminated, matching every real call site today). A
// `reason:` written as the sole property of a single-line object literal,
// or built via `Object.assign`/spread instead of a literal, would not match
// REASON_ASSIGNMENT_LINE and would slip through this specific check — the
// discovery test (part 1) would still flag the file if it's new, but not a
// same-file change in a shape this regex doesn't recognize. That is a real,
// known gap, not an oversight: closing it fully needs a type-aware scan
// (an actual TypeScript AST walk), which was judged not worth the added
// complexity for a single-field, single-package concern. Treat this test,
// like the leak-fence, as a backstop — not a guarantee.

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TYPE_REFERENCE = /\bRequestNameResult\b/;
const REASON_ASSIGNMENT_LINE = /^\s*reason\s*:\s*.+,\s*$/;

interface Surface {
  file: string;
  /**
   * Golden set of trimmed `reason:` assignment lines expected in this file,
   * in file order. Omit for the interface's own definition file, which this
   * scan doesn't apply to. An empty array asserts the file constructs
   * RequestNameResult objects but never sets `reason` on any of them.
   */
  reasonAssignments?: string[];
  /** Test file whose sentinel assertions cover this surface's rendered output, if any. */
  sentinelTest?: string;
}

const SURFACES: Surface[] = [
  // The interface's own definition — not a construction or render site.
  { file: 'src/request/store.ts' },
  {
    file: 'src/web/routes/import-form.ts',
    reasonAssignments: ["reason: f.errorCode === 'E_VALUE_AMBIGUOUS' ? f.message : undefined,"],
    sentinelTest: 'test/unit/web/routes/import-form.test.ts',
  },
  // Issue #61: surfaces EnigmaError.message from a per-name setSecret()
  // write failure, so the failure page can name what went wrong (e.g.
  // "E_WRITE_FAILED: failed to write secret to secret-service depository")
  // instead of a bare error code. E_MISSING_VALUE (no EnigmaError involved)
  // still gets no reason. Audited every EnigmaError this call site's
  // setSecret() can throw (src/storage/manager.ts + all depositories'
  // `set()`) and confirmed each message is static or interpolates only
  // structural text (secret NAME, depository id, byte limit, ref pattern) —
  // never opts.value.
  {
    file: 'src/web/routes/request-form.ts',
    // Issue #71 adds the first entry: a refused name (duplicate across
    // declared/rows/blob, or an ambiguous blob line) carries only
    // ParsedDotEnvEntry.ambiguousReason — the same static, value-free text
    // import already uses — or undefined. The second is Issue #61's, unchanged.
    reasonAssignments: ['reason: planned.refusal.reason,', 'reason: err instanceof EnigmaError ? err.message : undefined,'],
    sentinelTest: 'test/unit/web/routes/request-form.test.ts',
  },
  // Constructs RequestNameResult for the native/elicitation request paths
  // (never setting reason on it — hence the two entries below being the
  // full golden set even though this file constructs RequestNameResult).
  // The three comma-terminated `reason:` lines it DOES have all belong to
  // RequestArgs/RequestRecord.reason — the user-typed, free-text request
  // justification, a different field on a different type from
  // RequestNameResult.reason — or to the zod input-schema declaration for
  // that same field. None of these ever carry a *parsed* value.
  {
    file: 'src/mcp/tools/request.ts',
    reasonAssignments: ['reason: args.reason,', 'reason: z.string(),', 'reason: args.reason,'],
  },
  {
    file: 'src/mcp/tools/import.ts',
    reasonAssignments: [],
    sentinelTest: 'test/unit/mcp/import.test.ts',
  },
  // Shared renderer: folds `.reason` into output text for every caller
  // above. It never constructs a RequestNameResult itself, so there is no
  // assignment to pin here — its safety is entirely inherited from the
  // assignment sites above being safe. No dedicated sentinel: it's exercised
  // end-to-end by every sentinel test listed elsewhere in this registry.
  { file: 'src/mcp/result-text.ts' },
  {
    file: 'src/cli/commands/import.ts',
    reasonAssignments: [],
    sentinelTest: 'test/unit/cli/commands/import.test.ts',
  },
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('RequestNameResult.reason surfaces are tracked systematically (Issue #38)', () => {
  it('every src/ file referencing RequestNameResult is registered in SURFACES', () => {
    const referencing = walkTsFiles(join(REPO_ROOT, 'src'))
      .filter((f) => TYPE_REFERENCE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f))
      .sort();
    const registered = SURFACES.map((s) => s.file).sort();

    expect(
      referencing,
      'A src/ file references RequestNameResult but is not registered in SURFACES in ' +
        'test/unit/reason-field-surfaces.test.ts. Add it: decide whether it constructs ' +
        'RequestNameResult objects (and if so, record its exact `reason:` assignment lines, or an ' +
        'empty array if it never sets reason), and give it a sentinel test if it renders `reason` ' +
        'toward a model, browser response, or CLI stdout.',
    ).toEqual(registered);
  });

  for (const surface of SURFACES.filter((s) => s.reasonAssignments !== undefined)) {
    it(`${surface.file}: reason: assignments match the registered golden set`, () => {
      const content = readFileSync(join(REPO_ROOT, surface.file), 'utf8');
      const found = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => REASON_ASSIGNMENT_LINE.test(l));

      expect(
        found,
        `${surface.file} has reason: assignment(s) that don't match the golden set recorded for it ` +
          'in SURFACES (test/unit/reason-field-surfaces.test.ts). If this is a deliberate, reviewed ' +
          "change, update that golden set. Before doing so: can this new right-hand side's value ever " +
          'embed parsed input rather than static structural text? If it can, it does not belong in ' +
          "reason (see RequestNameResult's doc comment in src/request/store.ts).",
      ).toEqual(surface.reasonAssignments);
    });
  }

  for (const surface of SURFACES.filter((s): s is Surface & { sentinelTest: string } => Boolean(s.sentinelTest))) {
    it(`${surface.file}: sentinel coverage exists at ${surface.sentinelTest}`, () => {
      const content = readFileSync(join(REPO_ROOT, surface.sentinelTest), 'utf8');
      expect(
        content,
        `${surface.sentinelTest} has no ".not.toContain(" assertion — it may no longer prove a ` +
          `planted value can't survive into ${surface.file}'s rendered output.`,
      ).toMatch(/\.not\.toContain\(/);
    });
  }
});
