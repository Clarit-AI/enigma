// Parses and rewrites a plain (non-Enigma-managed) `.env` file for `enigma
// import` (Issue #13, D4.3). Lives under src/storage/** because it handles
// raw secret values while parsing/removing them from text (style-guide
// secret-handling conventions).
import { NAME_PATTERN } from '../core/naming.js';

const BEGIN_MARKER = '# enigma:begin';
const END_MARKER = '# enigma:end';

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
  /** One entry per distinct valid name, in first-seen order, holding the LAST value assigned to it (shell/dotenv semantics) — except a duplicated name, which is flagged `ambiguous` instead of resolved either way; see `ParsedDotEnvEntry.ambiguousReason`. */
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

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function findManagedBlock(lines: string[]): { beginIdx: number; endIdx: number } | undefined {
  const beginIdx = lines.findIndex((l) => l === BEGIN_MARKER);
  if (beginIdx === -1) return undefined;
  const endIdx = lines.findIndex((l, i) => l === END_MARKER && i > beginIdx);
  if (endIdx === -1) return undefined;
  return { beginIdx, endIdx };
}

const ASSIGNMENT = /^(?:export\s+)?([^\s=]+)=(.*)$/;

/**
 * Scans `lines` outside `block` (the existing managed block, if any — those
 * entries are already imported) for `[export] NAME=VALUE` assignments,
 * consuming a `"`- or `'`-opened value across as many physical lines as
 * needed until its matching unescaped closing quote (so a PEM-style
 * multi-line value parses, and later removes, as one unit).
 */
function scanAssignments(lines: string[], block: { beginIdx: number; endIdx: number } | undefined): ScannedAssignment[] {
  const assignments: ScannedAssignment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (block && i >= block.beginIdx && i <= block.endIdx) {
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
      // quote, bounded by EOF or the managed block. An unterminated quote (malformed or
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
        if (nextIdx >= lines.length || (block && nextIdx >= block.beginIdx && nextIdx <= block.endIdx)) break;
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

/** Parses a plain `.env` file's content into importable entries (D4.3). Never throws on malformed input — unparseable lines are simply skipped. */
export function parseDotEnv(content: string): ParseDotEnvResult {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findManagedBlock(lines);
  const assignments = scanAssignments(lines, block);

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
 * whether it ends with a trailing newline. When `opts.comment` is given, the
 * first removed line's position is replaced with that single comment line
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
  const block = findManagedBlock(lines);
  const assignments = scanAssignments(lines, block);

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
