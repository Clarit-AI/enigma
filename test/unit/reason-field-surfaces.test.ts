import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative } from 'node:path';
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
    // leak-fence's security fixtures (test/security/leak-fence.test.ts) are
    // written into real src/ paths mid-run — the fence scans the real tree, so
    // they must live there — and deleted in that file's afterEach. Under full
    // parallel `npm test` this walk can list one that is deleted before the
    // read below. This NAME-BASED skip is the whole fixture-race handling
    // (PR #78 review): known __leak-fence-fixture-* entries are ephemeral
    // test artifacts, never RequestNameResult surfaces to register.
    //
    // Deliberately NO catch around the later read: a read error on any OTHER
    // file must propagate and fail this inventory. Swallowing errors there
    // would drop the file from the scan — silently hiding a possible
    // unregistered surface, which is the exact failure this registry exists
    // to prevent. The fixture-name skip above is the only transient condition
    // treated as "not a surface", and only because those names are a proven
    // fixture convention of one test file.
    if (entry.name.startsWith('__leak-fence-fixture-')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every .ts file under root whose text references RequestNameResult. */
function listTsFilesReferencing(root: string): string[] {
  return readReferencingFiles(walkTsFiles(root))
    .map((f) => relative(REPO_ROOT, f))
    .sort();
}

/**
 * Read stage of the inventory (PR #78 review: kept separately testable so the
 * negative path is provable): a read error on ANY path here propagates — only
 * walkTsFiles' fixture-name skip, never this read, decides "not a surface".
 */
function readReferencingFiles(paths: string[]): string[] {
  return paths.filter((f) => TYPE_REFERENCE.test(readFileSync(f, 'utf8')));
}

describe('RequestNameResult.reason surfaces are tracked systematically (Issue #38)', () => {
  it('every src/ file referencing RequestNameResult is registered in SURFACES', () => {
    const referencing = listTsFilesReferencing(join(REPO_ROOT, 'src'))
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

  it('a non-fixture file that vanishes before the read is an ERROR, not a silent "no surface" (PR #78 review negative path)', () => {
    // Proves the read stage propagates instead of swallowing: a listed file
    // is deleted after walkTsFiles, so readFileSync throws ENOENT. A broad
    // catch would turn this into "the file references nothing" and quietly
    // drop a possible unregistered surface from the inventory — the exact
    // regression this guards against. No fixtures involved, so the
    // fixture-name exclusion cannot be what saves this run.
    const dir = mkdtempSync(join(tmpdir(), 'reason-field-vanish-'));
    try {
      writeFileSync(join(dir, 'kept.ts'), 'export type K = RequestNameResult;\n');
      const doomed = join(dir, 'doomed.ts');
      writeFileSync(doomed, 'export type D = RequestNameResult;\n');

      const listed = walkTsFiles(dir);
      expect(listed.map((f) => basename(f)).sort()).toEqual(['doomed.ts', 'kept.ts']);

      rmSync(doomed);
      expect(() => readReferencingFiles(listed), 'a non-fixture read error must propagate').toThrow(
        /ENOENT/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // chmod 0o000 only blocks reads for a non-root owner on POSIX; Windows
  // ignores the read bit. Root/Windows guard (PR #78 batch): the vanish
  // case above still covers the read-error-propagates property on every
  // platform, so skipping this stronger unreadable-file variant there
  // costs no coverage of the actual contract.
  it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))(
    'an unreadable non-fixture surface file throws — it cannot be silently omitted as "no surface" (PR #78 review negative path)',
    () => {
    // The lead's exact concern: a newly added file that DOES reference
    // RequestNameResult but cannot be read. A broad catch around the read
    // would return false for it and quietly drop it from the inventory,
    // leaving an unregistered surface invisible to this test. With errors
    // propagating, the read throws and the inventory fails loudly instead.
    // Unreadable-but-existing is distinct from the vanished case above: the
    // path is still there at read time (chmod, not delete), so no fixture
    // race is involved and the name exclusion cannot apply.
    const dir = mkdtempSync(join(tmpdir(), 'reason-field-unreadable-'));
    const target = join(dir, 'hidden-surface.ts');
    try {
      writeFileSync(target, 'export type H = RequestNameResult;\n');
      expect(readReferencingFiles(walkTsFiles(dir)).map((f) => basename(f))).toEqual(['hidden-surface.ts']);

      chmodSync(target, 0o000);
      expect(
        () => listTsFilesReferencing(dir),
        'an unreadable non-fixture file must fail the inventory, never be read as "references nothing"',
      ).toThrow();

      chmodSync(target, 0o644);
      expect(readReferencingFiles(walkTsFiles(dir)).map((f) => basename(f))).toEqual(['hidden-surface.ts']);
    } finally {
      chmodSync(target, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
    },
  );

  it('fixture-named entries are excluded by NAME before any read (the narrow exclusion, PR #78 review)', () => {
    // Positive control for the exclusion being name-based and fixture-scoped:
    // a __leak-fence-fixture-* file is never listed, so there is nothing to
    // read and nothing to error on — while a sibling non-fixture .ts with
    // identical content is listed and read normally.
    const dir = mkdtempSync(join(tmpdir(), 'reason-field-fixture-'));
    try {
      writeFileSync(join(dir, '__leak-fence-fixture-demo__.ts'), 'export type F = RequestNameResult;\n');
      writeFileSync(join(dir, 'real.ts'), 'export type R = RequestNameResult;\n');

      expect(walkTsFiles(dir).map((f) => basename(f))).toEqual(['real.ts']);
      expect(readReferencingFiles(walkTsFiles(dir)).map((f) => basename(f))).toEqual(['real.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
