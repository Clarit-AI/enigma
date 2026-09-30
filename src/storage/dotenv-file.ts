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

/** Result of walking every render marker in a file (`scanRenderMarkers`). */
export interface RenderMarkerScan {
  /** Every begin..end pair, in file order (inclusive line indices). */
  complete: Array<{ beginIdx: number; endIdx: number }>;
  /** Line index of the first render begin marker that is never closed, if any. */
  unterminatedBeginIdx?: number;
  /** True unless the file has zero or exactly one well-formed render block: an unterminated begin, a stray end, a nested begin, or more than one block. */
  damaged: boolean;
}

/**
 * Walks ALL render markers (not just the first pair). The renderer refuses a
 * damaged file; import protects every complete block and everything from the
 * first unterminated begin to EOF.
 */
export function scanRenderMarkers(lines: string[]): RenderMarkerScan {
  const complete: Array<{ beginIdx: number; endIdx: number }> = [];
  let openIdx = -1;
  let irregular = false;
  lines.forEach((line, i) => {
    if (line === RENDER_BEGIN_MARKER) {
      if (openIdx === -1) openIdx = i;
      else irregular = true; // nested begin
    } else if (line === RENDER_END_MARKER) {
      if (openIdx === -1) {
        irregular = true; // stray end
      } else {
        complete.push({ beginIdx: openIdx, endIdx: i });
        openIdx = -1;
      }
    }
  });
  const scan: RenderMarkerScan = { complete, damaged: irregular || openIdx !== -1 || complete.length > 1 };
  if (openIdx !== -1) scan.unterminatedBeginIdx = openIdx;
  return scan;
}

/** All marker pairs that mark Enigma-managed content inside a `.env` file. Used by the import path's "skip managed lines" filter. */
export const MANAGED_BLOCK_MARKERS: readonly BlockMarkers[] = [
  { begin: ENV_BEGIN_MARKER, end: ENV_END_MARKER },
  { begin: RENDER_BEGIN_MARKER, end: RENDER_END_MARKER },
];

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
 * Line ranges of every managed block in `lines`. Every complete render
 * block is protected, and from the first UNTERMINATED render begin marker to
 * EOF is protected too (a damaged file), so none of those lines is ever
 * imported or stripped. The env depository's block keeps its own handling
 * (first begin/end pair; unterminated, it is simply not a block).
 */
function managedBlockRanges(lines: string[]): Array<{ beginIdx: number; endIdx: number }> {
  const ranges: Array<{ beginIdx: number; endIdx: number }> = [];
  const envBlock = findBlock(lines, { begin: ENV_BEGIN_MARKER, end: ENV_END_MARKER });
  if (envBlock) ranges.push(envBlock);
  const render = scanRenderMarkers(lines);
  ranges.push(...render.complete);
  if (render.unterminatedBeginIdx !== undefined) ranges.push({ beginIdx: render.unterminatedBeginIdx, endIdx: lines.length - 1 });
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
function scanAssignments(lines: string[]): ScannedAssignment[] {
  const blocks = managedBlockRanges(lines);
  const assignments: ScannedAssignment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isInsideAnyManagedBlock(blocks, i)) {
      i++;
      continue;
    }
    const line = lines[i]!;
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
        joined += `\n${lines[endIdx]}`;
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
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const assignments = scanAssignments(lines);

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
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const assignments = scanAssignments(lines);

  const targets = new Set(names);
  const toRemove = assignments.filter((a) => a.valid && targets.has(a.name));
  if (toRemove.length === 0) return content;

  const removedLineIdx = new Set<number>();
  for (const a of toRemove) {
    for (let idx = a.startIdx; idx <= a.endIdx; idx++) removedLineIdx.add(idx);
  }
  const firstRemovedIdx = Math.min(...toRemove.map((a) => a.startIdx));

  const newLines: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (!removedLineIdx.has(idx)) {
      newLines.push(lines[idx]!);
      continue;
    }
    if (idx === firstRemovedIdx && opts.comment) newLines.push(opts.comment);
  }

  return newLines.join(eol);
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
 * Returns every `NAME=line` (raw bytes) currently in the named block,
 * preserving the order they appeared in the file. The renderer uses this
 * to copy previously-rendered lines byte-identical when a follow-up render
 * doesn't need to re-resolve them (Issue #107).
 */
export function readManagedBlockLines(content: string, markers: BlockMarkers): string[] {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines, markers);
  return block ? lines.slice(block.beginIdx + 1, block.endIdx) : [];
}

/**
 * Write a block whose body is exactly `bodyLines` (raw `NAME=value` lines,
 * already encoded). An existing block is rewritten in place, wherever it is;
 * a new one is appended at EOF, after any existing env block. Either way the
 * block ends with an EOL in the file's style, so a later `echo X >> file`
 * starts on its own line and can never glue onto the end marker: an existing
 * block that sits at EOF without a trailing newline (a hand edit, or a file
 * written by an older build) gains one when it is rewritten. A file that had
 * no trailing newline therefore gains one before the block and one after it;
 * stripping the block later leaves that one EOL behind.
 */
export function writeManagedBlock(content: string, bodyLines: readonly string[], markers: BlockMarkers): string {
  const eol = detectEol(content);
  const existing = findBlock(content.length === 0 ? [] : content.split(eol), markers);
  if (existing) {
    const lines = content.split(eol);
    const newLines = [...lines.slice(0, existing.beginIdx + 1), ...bodyLines, ...lines.slice(existing.endIdx)];
    const rewritten = newLines.join(eol);
    // The end marker is the file's last line: end it with an EOL too.
    return existing.endIdx === lines.length - 1 ? `${rewritten}${eol}` : rewritten;
  }
  const needsNewline = content.length > 0 && !content.endsWith(eol);
  const prefix = needsNewline ? content + eol : content;
  return `${prefix}${markers.begin}${eol}${bodyLines.join(eol)}${eol}${markers.end}${eol}`;
}

export { FILE_MODE };
