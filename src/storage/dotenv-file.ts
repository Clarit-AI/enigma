// Parses and rewrites plain (non-Enigma-managed) and managed `.env` content
// for `enigma import` (Issue #13, D4.3) and `enigma render` (Issue #107).
// Lives under src/storage/** because it handles raw secret values while
// parsing/removing them from text (style-guide secret-handling conventions).
import { NAME_PATTERN } from '../core/naming.js';

/**
 * The two managed-block marker pairs Enigma writes into a `.env` file.
 *
 * - `# enigma:begin` / `# enigma:end` — the `env` depository's own block,
 *   one line per stored secret, `ref` is the bare `NAME` (D1.9).
 * - `# enigma:render:begin` / `# enigma:render:end` — the renderer (Issue
 *   #107) writes its own block, distinct from the depository's so they
 *   coexist in one file without colliding. Both blocks are skipped on
 *   import and on removal — neither's lines are re-imported, neither's
 *   bytes are ever parsed to a value here (Issue #107 leak-fence).
 */
export const ENV_BEGIN_MARKER = '# enigma:begin';
export const ENV_END_MARKER = '# enigma:end';
export const RENDER_BEGIN_MARKER = '# enigma:render:begin';
export const RENDER_END_MARKER = '# enigma:render:end';

/** One (begin, end) marker pair. The renderer and the env depository share the findBlock shape through this. */
export interface BlockMarkers {
  begin: string;
  end: string;
}

const NEEDS_QUOTING = /[\s#"'\\$]/;

export function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * One PHYSICAL line: the text before a `\n`, plus that `\n` (`term`; empty for
 * a last line with no newline). `raw + term` reproduces the original bytes
 * exactly. `text` is `raw` without the one `\r` that belongs to a `\r\n`
 * terminator, and is what scanning, recognition and parsing look at.
 */
export interface PhysicalLine {
  raw: string;
  term: '\n' | '';
  text: string;
}

/**
 * Splits at LF only, so a file with mixed line endings never merges an
 * LF-terminated line (a marker included) into its neighbor, which splitting on
 * one guessed EOL does. An empty string has no lines; a trailing newline does
 * not create an extra empty line.
 */
export function splitPhysicalLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf('\n', start);
    if (nl === -1) {
      const raw = content.slice(start);
      lines.push({ raw, term: '', text: raw });
      break;
    }
    const raw = content.slice(start, nl);
    lines.push({ raw, term: '\n', text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    start = nl + 1;
  }
  return lines;
}

/** Inverse of `splitPhysicalLines`: every line's own bytes and terminator, unchanged. */
export function joinPhysicalLines(lines: readonly PhysicalLine[]): string {
  return lines.map((l) => l.raw + l.term).join('');
}

/** The more common of `\r\n` and `\n` among the terminated lines; `\n` on a tie or when there are none. Used only to choose the terminator of lines the renderer writes. */
export function dominantEol(lines: readonly PhysicalLine[]): '\r\n' | '\n' {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.term !== '\n') continue;
    if (l.raw.endsWith('\r')) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Dotenv-compatible encoding: bare when safe, else double-quoted with `\`, `"`, CR, and LF escaped. */
export function encodeValue(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Exact inverse of encodeValue: unwraps a double-quoted value and unescapes `\\`, `\"`, `\r`, `\n`. */
export function decodeValue(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\\\|\\"|\\r|\\n/g, (escape) => {
    switch (escape) {
      case '\\\\':
        return '\\';
      case '\\"':
        return '"';
      case '\\r':
        return '\r';
      default:
        return '\n';
    }
  });
}

/**
 * Find a single block delimited by `markers.begin` and `markers.end`. Returns
 * the inclusive line indices of the begin and end markers in `lines`, or
 * `undefined` if either is absent. A file may carry both managed blocks in
 * any order (the env block + the render block); each `findBlock` call finds
 * its own pair and only its own.
 */
export function findBlock(lines: string[], markers: BlockMarkers): { beginIdx: number; endIdx: number } | undefined {
  const beginIdx = lines.findIndex((l) => l === markers.begin);
  if (beginIdx === -1) return undefined;
  const endIdx = lines.findIndex((l, i) => l === markers.end && i > beginIdx);
  if (endIdx === -1) return undefined;
  return { beginIdx, endIdx };
}

/** Result of `scanRenderMarkers`. */
export interface RenderMarkerScan {
  /** True unless the file is well-formed (see `scanRenderMarkers`). */
  damaged: boolean;
  /** The one render block (inclusive line indices), set iff the file is well-formed and has exactly one. */
  block?: { beginIdx: number; endIdx: number };
  /** Line index of the FIRST render begin marker, if the file has any. */
  firstBeginIdx?: number;
}

const TRAILING_WHITESPACE = /[ \t\r]+$/;

type MarkerKind = 'render-begin' | 'render-end' | 'env-begin' | 'env-end';

/** A line is a marker if, after removing trailing whitespace (spaces, tabs, a CR), it equals one of the four marker lines. */
function markerKind(line: string): MarkerKind | undefined {
  switch (line.replace(TRAILING_WHITESPACE, '')) {
    case RENDER_BEGIN_MARKER:
      return 'render-begin';
    case RENDER_END_MARKER:
      return 'render-end';
    case ENV_BEGIN_MARKER:
      return 'env-begin';
    case ENV_END_MARKER:
      return 'env-end';
    default:
      return undefined;
  }
}

/**
 * Every env-depository block range in `lines`, as the UNION of two views, so
 * this module's code can never disagree with itself about where an env block
 * is: the EXACT view (what the env depository sees: the first line equal to
 * `# enigma:begin` and the first exact `# enigma:end` after it) and the
 * TRIMMED view (markers recognized after trailing whitespace is removed, each
 * begin paired with the next end). The env depository's own code is unchanged.
 */
export function envBlockRanges(lines: string[]): Array<{ beginIdx: number; endIdx: number }> {
  const ranges: Array<{ beginIdx: number; endIdx: number }> = [];
  const exact = findBlock(lines, { begin: ENV_BEGIN_MARKER, end: ENV_END_MARKER });
  if (exact) ranges.push(exact);
  let open = -1;
  lines.forEach((line, i) => {
    const kind = markerKind(line);
    if (kind === 'env-begin' && open === -1) open = i;
    else if (kind === 'env-end' && open !== -1) {
      ranges.push({ beginIdx: open, endIdx: i });
      open = -1;
    }
  });
  return ranges;
}

/**
 * The single rule for render markers, shared by the renderer and import.
 *
 * Marker recognition: a line is a render marker if, after removing trailing
 * whitespace (spaces, tabs, a CR), it equals `# enigma:render:begin` or
 * `# enigma:render:end`. The env depository's markers are recognized the same
 * way for this scan only; its own read/write code is unchanged.
 *
 * Only TRAILING whitespace is trimmed: leading whitespace or any other
 * character means "not a marker". Callers pass each physical line's `text`
 * (split at LF, one CR of a CRLF ignored; see `splitPhysicalLines`).
 *
 * A file is WELL-FORMED when it has exactly zero render markers, or exactly one
 * render begin followed later by exactly one render end, with no other render
 * marker anywhere, no env-depository marker between that begin and end, and no
 * env-depository block, from EITHER the exact or the trimmed view (see
 * `envBlockRanges`), that overlaps or contains the render block.
 * Anything else is DAMAGED (a nested begin, a repeated block, a stray end, an
 * unterminated begin, env markers inside the render range, a render block
 * inside or overlapping an env block).
 *
 * The renderer refuses a damaged file. Import protects the one render block of
 * a well-formed file; in a damaged file it protects everything from the FIRST
 * render begin to EOF (and nothing when there is no render begin, e.g. only
 * stray ends).
 */
export function scanRenderMarkers(lines: string[]): RenderMarkerScan {
  const beginIdxs: number[] = [];
  const endIdxs: number[] = [];
  const envIdxs: number[] = [];
  lines.forEach((line, i) => {
    const kind = markerKind(line);
    if (kind === 'render-begin') beginIdxs.push(i);
    else if (kind === 'render-end') endIdxs.push(i);
    else if (kind === 'env-begin' || kind === 'env-end') envIdxs.push(i);
  });
  const scan: RenderMarkerScan = { damaged: false };
  if (beginIdxs.length > 0) scan.firstBeginIdx = beginIdxs[0];
  if (beginIdxs.length === 0 && endIdxs.length === 0) return scan;
  const wellFormed =
    beginIdxs.length === 1 &&
    endIdxs.length === 1 &&
    beginIdxs[0]! < endIdxs[0]! &&
    !envIdxs.some((i) => i > beginIdxs[0]! && i < endIdxs[0]!) &&
    !envBlockRanges(lines).some((r) => r.beginIdx < endIdxs[0]! && r.endIdx > beginIdxs[0]!);
  if (wellFormed) scan.block = { beginIdx: beginIdxs[0]!, endIdx: endIdxs[0]! };
  else scan.damaged = true;
  return scan;
}

/**
 * True when line index `i` of `lines` sits inside any Enigma-managed block.
 * Used by the scanner to skip both blocks in a single pass, regardless of
 * which appears first in the file.
 */
function isInsideAnyManagedBlock(blocks: ReadonlyArray<{ beginIdx: number; endIdx: number }>, i: number): boolean {
  for (const b of blocks) {
    if (i >= b.beginIdx && i <= b.endIdx) return true;
  }
  return false;
}

/**
 * Line ranges import must skip. The render range follows `scanRenderMarkers`:
 * the one block of a well-formed file, or from the first render begin to EOF
 * in a damaged one. Every env-depository range from either view
 * (`envBlockRanges`: exact and trimmed) is skipped as well; where they
 * overlap the render range the union is skipped.
 */
function managedBlockRanges(lines: string[]): Array<{ beginIdx: number; endIdx: number }> {
  const ranges = envBlockRanges(lines);
  const render = scanRenderMarkers(lines);
  if (render.block) ranges.push(render.block);
  else if (render.damaged && render.firstBeginIdx !== undefined) ranges.push({ beginIdx: render.firstBeginIdx, endIdx: lines.length - 1 });
  return ranges;
}

export interface ParsedDotEnvEntry {
  name: string;
  value: string;
  /**
   * True when this entry is ambiguous and must be refused rather than
   * guessed at (Issue #13 review, round 2/3) — one mechanism, two triggers:
   *
   * - an UNQUOTED value contains a space followed by `#` (e.g.
   *   `PORT=3000 # dev port`) — ambiguous whether the `#` starts a trailing
   *   comment or is itself part of the secret (e.g. a passphrase like
   *   `hunter2 #1`); or
   * - the name is assigned more than once in the file. Folding to the last
   *   value and removing every physical line (the original design) silently
   *   discards an earlier occurrence's value with no depository copy
   *   anywhere; removing only the last occurrence is worse, not better — it
   *   promotes the shadowed earlier line to the file's only value for that
   *   name, silently changing what the application loads. Every removal
   *   choice is wrong, so none is taken: refuse instead.
   *
   * A quoted value is never ambiguous on the first trigger — its boundary
   * is already explicit — but IS still ambiguous on the second if its name
   * is duplicated.
   */
  ambiguous: boolean;
  /** Set iff `ambiguous`: a short, user-facing reason a caller can surface verbatim in a refusal message. */
  ambiguousReason?: string;
}

export interface ParseDotEnvResult {
  /** One entry per distinct valid name, in first-seen order, holding the LAST value assigned to it (shell/dotenv semantics) — except a duplicated name, which is flagged `ambiguous` and refused rather than migrated either way; see `ParsedDotEnvEntry.ambiguousReason`. */
  entries: ParsedDotEnvEntry[];
  /** Names that don't match the canonical `^[A-Z][A-Z0-9_]*$` pattern (src/core/naming.ts) — never imported, their line(s) left untouched. */
  invalidNames: string[];
  /** Valid names assigned more than once. Reported for visibility; the corresponding entry is also `ambiguous` and refused rather than migrated. */
  duplicateNames: string[];
}

interface ScannedAssignment {
  name: string;
  value: string;
  valid: boolean;
  ambiguous: boolean;
  ambiguousReason?: string;
  startIdx: number;
  /** Inclusive. */
  endIdx: number;
}

const INLINE_COMMENT_REASON =
  'the unquoted value contains a space then "#", which could start a comment or be part of the secret — quote the value if the # belongs to it, then rerun import';

/** An unquoted raw remainder is ambiguous when it contains a space immediately before `#` — the classic inline-comment signal most dotenv readers use, so we must not guess which side of it the user meant. */
function isAmbiguousUnquoted(raw: string): boolean {
  return / #/.test(raw);
}

/**
 * Scans `lines` outside any Enigma-managed block (the env depository's
 * `# enigma:begin` block AND the renderer's `# enigma:render:begin` block)
 * for `[export] NAME=VALUE` assignments, consuming a `"`- or `'`-opened
 * value across as many physical lines as needed until its matching
 * unescaped closing quote (so a PEM-style multi-line value parses, and
 * later removes, as one unit). Both blocks in either order are skipped
 * without distinguishing them — neither block's lines are ever imported
 * or stripped.
 */
function scanAssignments(lines: PhysicalLine[]): ScannedAssignment[] {
  const blocks = managedBlockRanges(lines.map((l) => l.text));
  const assignments: ScannedAssignment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isInsideAnyManagedBlock(blocks, i)) {
      i++;
      continue;
    }
    const line = lines[i]!.text;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const match = ASSIGNMENT.exec(trimmed);
    if (!match) {
      i++;
      continue;
    }
    const name = match[1]!;
    const rest = match[2]!;
    const quote = rest[0];

    if (quote === '"' || quote === "'") {
      // Scan forward (joining physical lines with \n) for the matching unescaped closing
      // quote, bounded by EOF or any managed block. An unterminated quote (malformed or
      // hostile input) must NOT swallow the rest of the file: falls back to parsing just
      // this one line raw, so every later line is still scanned fresh and independently.
      let joined = rest.slice(1);
      let endIdx = i;
      let closed = false;
      for (;;) {
        const closeIdx = findUnescapedQuote(joined, quote);
        if (closeIdx !== -1) {
          joined = joined.slice(0, closeIdx);
          closed = true;
          break;
        }
        const nextIdx = endIdx + 1;
        if (nextIdx >= lines.length || isInsideAnyManagedBlock(blocks, nextIdx)) break;
        endIdx = nextIdx;
        joined += `\n${lines[endIdx]!.text}`;
      }
      if (closed) {
        // A closed quote's boundary is explicit — never ambiguous, whatever it contains.
        assignments.push({ name, value: joined, valid: NAME_PATTERN.test(name), ambiguous: false, startIdx: i, endIdx });
        i = endIdx + 1;
      } else {
        const ambiguous = isAmbiguousUnquoted(rest);
        assignments.push({
          name,
          value: rest.trim(),
          valid: NAME_PATTERN.test(name),
          ambiguous,
          ambiguousReason: ambiguous ? INLINE_COMMENT_REASON : undefined,
          startIdx: i,
          endIdx: i,
        });
        i++;
      }
      continue;
    }

    {
      const ambiguous = isAmbiguousUnquoted(rest);
      assignments.push({
        name,
        value: rest.trim(),
        valid: NAME_PATTERN.test(name),
        ambiguous,
        ambiguousReason: ambiguous ? INLINE_COMMENT_REASON : undefined,
        startIdx: i,
        endIdx: i,
      });
      i++;
    }
  }
  return assignments;
}

/** Index of the first `quote` character in `text` not preceded by a backslash, or -1. */
function findUnescapedQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === quote && text[i - 1] !== '\\') return i;
  }
  return -1;
}

const ASSIGNMENT = /^(?:export\s+)?([^\s=]+)=(.*)$/;

/** Parses a plain `.env` file's content into importable entries (D4.3). Never throws on malformed input — unparseable lines are simply skipped. Lines inside any Enigma-managed block are skipped at scan time, not parsed at all. */
export function parseDotEnv(content: string): ParseDotEnvResult {
  const assignments = scanAssignments(splitPhysicalLines(content));

  const order: string[] = [];
  const values = new Map<string, string>();
  const ambiguousFlags = new Map<string, boolean>();
  const ambiguousReasons = new Map<string, string | undefined>();
  const invalidSeen = new Set<string>();
  const duplicateSeen = new Set<string>();

  for (const a of assignments) {
    if (!a.valid) {
      invalidSeen.add(a.name);
      continue;
    }
    if (values.has(a.name)) duplicateSeen.add(a.name);
    else order.push(a.name);
    values.set(a.name, a.value);
    ambiguousFlags.set(a.name, a.ambiguous);
    ambiguousReasons.set(a.name, a.ambiguousReason);
  }

  return {
    entries: order.map((name) => {
      const isDuplicate = duplicateSeen.has(name);
      return {
        name,
        value: values.get(name)!,
        ambiguous: isDuplicate || ambiguousFlags.get(name)!,
        ambiguousReason: isDuplicate
          ? `${name} is assigned more than once in this file — remove the duplicate line(s) and rerun import`
          : ambiguousReasons.get(name),
      };
    }),
    invalidNames: [...invalidSeen],
    duplicateNames: [...duplicateSeen],
  };
}

/**
 * Removes every raw assignment line for each name in `names`, preserving
 * every other line byte-identical — including the file's EOL style and
 * whether it ends with a trailing newline. Lines inside any Enigma-managed
 * block are also left untouched (the scanner skipped them, so they were
 * never in the candidate set). When `opts.comment` is given, the first
 * removed line's position is replaced with that single comment line
 * instead of being elided entirely; omit it to remove silently (the `env`
 * depository case, where the managed block itself already documents the
 * move).
 *
 * This is a low-level, "do what it's told" primitive: it removes every
 * physical occurrence of a name without judging whether that's safe. The
 * real safety property — a duplicated name is never migrated or removed in
 * the first place — lives one layer up, in `parseDotEnv` flagging it
 * `ambiguous` and `commitImport` refusing it (Issue #13 review, round 3):
 * this function is never asked to remove a duplicated name via that path.
 */
export function removeDotEnvEntries(content: string, names: string[], opts: { comment?: string } = {}): string {
  const lines = splitPhysicalLines(content);
  const assignments = scanAssignments(lines);

  const targets = new Set(names);
  const toRemove = assignments.filter((a) => a.valid && targets.has(a.name));
  if (toRemove.length === 0) return content;

  const removedLineIdx = new Set<number>();
  for (const a of toRemove) {
    for (let idx = a.startIdx; idx <= a.endIdx; idx++) removedLineIdx.add(idx);
  }
  const firstRemovedIdx = Math.min(...toRemove.map((a) => a.startIdx));

  // Every kept line keeps its own bytes and terminator. A comment takes over
  // the terminator of the line it replaces (CR included). `source` records the
  // physical line each output line came from.
  const out: PhysicalLine[] = [];
  const source: number[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (!removedLineIdx.has(idx)) {
      out.push(line);
      source.push(idx);
      continue;
    }
    if (idx === firstRemovedIdx && opts.comment) {
      const cr = line.term === '\n' && line.raw.endsWith('\r') ? '\r' : '';
      out.push({ raw: `${opts.comment}${cr}`, term: line.term, text: opts.comment });
      source.push(idx);
    }
  }
  // Removing a final unterminated line also drops the terminator before it, as
  // removal has always done, but never when that previous line is PROTECTED
  // (inside an env or render block, end marker included): a protected line's
  // bytes and terminator are never modified.
  const last = lines[lines.length - 1]!;
  if (removedLineIdx.has(lines.length - 1) && last.term === '' && out.length > 0) {
    const previousSource = source[source.length - 1]!;
    const protectedLine = isInsideAnyManagedBlock(managedBlockRanges(lines.map((l) => l.text)), previousSource);
    if (!protectedLine) {
      const tail = out[out.length - 1]!;
      out[out.length - 1] = { raw: tail.raw.endsWith('\r') && tail.term === '\n' ? tail.raw.slice(0, -1) : tail.raw, term: '', text: tail.text };
    }
  }
  return joinPhysicalLines(out);
}

/* ------------------------------------------------------------------ *
 *  Managed-block writers (shared by the env depository + the renderer) *
 * ------------------------------------------------------------------ *
 *
 * The env depository's `# enigma:begin` block and the renderer's
 * `# enigma:render:begin` block share the same shape — begin marker,
 * one `NAME=value` per line, end marker, EOF-appended when the block is
 * new — so the helper that writes one also writes the other. The block
 * finder is parameterized by marker pair; the writer takes a marker
 * pair so the renderer can ship its own delimiters without a second
 * copy of the surrounding EOL/trailing-newline/append logic.
 */

const FILE_MODE = 0o600;

/**
 * Writes/updates `name` inside the managed block, preserving every other line
 * byte-for-byte and the file's own line-ending style. Appends the block at
 * EOF — behind a single newline if the file doesn't already end with one —
 * when no block exists yet. Marker pair is supplied by the caller so the
 * env depository and the renderer can each use their own.
 */
export function upsertManagedBlock(
  content: string,
  name: string,
  value: string,
  markers: BlockMarkers,
): string {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines, markers);

  const encoded = encodeValue(value);
  if (block) {
    const blockLines = lines.slice(block.beginIdx + 1, block.endIdx);
    const existingIdx = blockLines.findIndex((l) => l.startsWith(`${name}=`));
    if (existingIdx !== -1) {
      blockLines[existingIdx] = `${name}=${encoded}`;
    } else {
      blockLines.push(`${name}=${encoded}`);
    }
    const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
    return newLines.join(eol);
  }

  const needsNewline = content.length > 0 && !content.endsWith(eol);
  const prefix = needsNewline ? content + eol : content;
  return `${prefix}${markers.begin}${eol}${name}=${encoded}${eol}${markers.end}${eol}`;
}

export function extractManagedValue(content: string, name: string, markers: BlockMarkers): string | undefined {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines, markers);
  if (!block) return undefined;
  const match = lines.slice(block.beginIdx + 1, block.endIdx).find((l) => l.startsWith(`${name}=`));
  return match ? decodeValue(match.slice(name.length + 1)) : undefined;
}

/**
 * Removes a single `name` line from the managed block identified by
 * `markers`, returning the content unchanged if the name isn't in the
 * block. Used by the env depository; the renderer uses its own block-merge
 * helper because it must keep previously-rendered prompting-store lines
 * verbatim (Issue #107).
 */
export function removeManagedValue(content: string, name: string, markers: BlockMarkers): string {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines, markers);
  if (!block) return content;
  const blockLines = lines.slice(block.beginIdx + 1, block.endIdx).filter((l) => !l.startsWith(`${name}=`));
  const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
  return newLines.join(eol);
}

/**
 * Write the render block with a body of exactly `bodyLines` (raw `NAME=value`
 * lines, already encoded). `existing` is the block's range from
 * `scanRenderMarkers` over the file's physical lines (a well-formed file's one
 * block): it is rewritten in place, wherever it is, with canonical markers.
 * Without it a new block is appended at EOF, after any env block.
 *
 * Every line outside the block keeps its original bytes and terminator. The
 * lines written here (markers and assignments) end with the file's DOMINANT
 * EOL (`dominantEol`), and the block always ends with one, so a later
 * `echo X >> file` starts on its own line and can never glue onto the end
 * marker. A last line with no newline is terminated (in the dominant EOL)
 * before a new block is appended after it.
 */
export function writeRenderBlock(content: string, bodyLines: readonly string[], existing?: { beginIdx: number; endIdx: number }): string {
  const lines = splitPhysicalLines(content);
  const eol = dominantEol(lines);
  const written = [RENDER_BEGIN_MARKER, ...bodyLines, RENDER_END_MARKER].map((text): PhysicalLine => ({ raw: text + (eol === '\r\n' ? '\r' : ''), term: '\n', text }));
  if (existing) {
    return joinPhysicalLines([...lines.slice(0, existing.beginIdx), ...written, ...lines.slice(existing.endIdx + 1)]);
  }
  const before = lines.map((l, i): PhysicalLine =>
    i === lines.length - 1 && l.term === '' ? { raw: l.raw + (eol === '\r\n' ? '\r' : ''), term: '\n', text: l.text } : l,
  );
  return joinPhysicalLines([...before, ...written]);
}

export { FILE_MODE };
