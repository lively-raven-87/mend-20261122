// mend — apply a patch written in any AI edit format.
//
// One tool for four patch languages: unified diffs, SEARCH/REPLACE blocks,
// V4A patches and JSON tool-call edits. It reads one patch, applies it to
// the directory it runs in, and changes every file or none at all.
// Node 22+, standard library only: node main.ts [options] [PATCH]

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Errors and small helpers
// ---------------------------------------------------------------------------

/** The patch is not written in its format. `line` counts from 1. */
class BadPatch extends Error {
  readonly line: number;
  constructor(line: number) {
    super('bad patch at line ' + line);
    this.line = line;
  }
}

function badPatch(line: number): never {
  throw new BadPatch(line);
}

/** A command-line problem. The message is printed and the run ends. */
class BadUsage extends Error {}

function badUsage(): never {
  throw new BadUsage();
}

/** One edit that could not be applied, and the path it concerns. */
type Failure = { code: string; path: string };

const failWith = (code: string, path: string): Failure => ({ code, path });

/** One parsed edit. It works on the in-memory file map and records moves. */
type Operation = {
  run(files: Map<string, string>, moves: Array<[string, string]>): Failure | null;
};

/** A relative path is usable when it is not empty, never starts with `/`,
 * holds no backslash, and none of its segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function trimRight(s: string): string {
  return s.replace(/[ \t\r]+$/, '');
}

function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Split patch text into lines: split at `\n`, drop the empty tail after a
 * final newline, strip one trailing `\r` from every line. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// File text: lines plus the file's own line break and final-break flag
// ---------------------------------------------------------------------------

class Doc {
  readonly lines: string[];
  readonly br: '\r\n' | '\n';
  readonly terminated: boolean;

  constructor(lines: string[], br: '\r\n' | '\n', terminated: boolean) {
    this.lines = lines;
    this.br = br;
    this.terminated = terminated;
  }

  static from(text: string): Doc {
    if (text === '') return new Doc([], '\n', false);
    const firstLf = text.indexOf('\n');
    const br: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
    const lines = text.split(br);
    let terminated = false;
    if (text.endsWith(br)) {
      lines.pop();
      terminated = true;
    }
    return new Doc(lines, br, terminated);
  }

  toString(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (this.terminated ? this.br : '');
  }
}

// ---------------------------------------------------------------------------
// Tiered line matching (SPEC section 5)
// ---------------------------------------------------------------------------

/** The comparison key of a line at a tier: 0 exact, 1 trailing space
 * ignored, 2 both ends ignored. */
function keyAt(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimRight(s);
  return trimRight(s.replace(/^[ \t]+/, ''));
}

/** Every 0-based offset at or after `from` where `pat` matches at `tier`. */
function occurrences(lines: string[], pat: string[], from: number, tier: number): number[] {
  const hits: number[] = [];
  const keys = pat.map((p) => keyAt(p, tier));
  for (let i = from; i + pat.length <= lines.length; i++) {
    let good = true;
    for (let k = 0; k < pat.length; k++) {
      if (keyAt(lines[i + k], tier) !== keys[k]) {
        good = false;
        break;
      }
    }
    if (good) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2 — only 0 when `strict`) at which `pat`
 * occurs at or after `from`, with every position. Null when it never does. */
function tieredOccurrences(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const positions = occurrences(lines, pat, from, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to `single`, trying tier 0, then
 * 1, then 2 (only 0 when `strict`). -1 when there is none. */
function singleOccurrence(lines: string[], single: string, from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const key = keyAt(single, tier);
    for (let i = from; i < lines.length; i++) {
      if (keyAt(lines[i], tier) === key) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Hunk/chunk bodies shared by unified diffs and V4A
// ---------------------------------------------------------------------------

type Mark = ' ' | '-' | '+' | '\\';

type BodyLine = {
  mark: Mark;
  /** The text after the marker; '' for an empty context line. */
  text: string;
  /** True when the patch line itself was empty (an empty context line). */
  empty: boolean;
};

/** A body split into the old lines and the new lines. Context lines keep
 * the index of the old line they came from, so they can be written back as
 * the file's own matched lines. */
type Split = {
  oldLines: string[];
  newLines: Array<{ mark: ' ' | '+'; text: string; oldIndex: number }>;
};

function splitBody(items: BodyLine[]): Split {
  const oldLines: string[] = [];
  const newLines: Array<{ mark: ' ' | '+'; text: string; oldIndex: number }> = [];
  for (const it of items) {
    if (it.mark === ' ') {
      newLines.push({ mark: ' ', text: it.text, oldIndex: oldLines.length });
      oldLines.push(it.text);
    } else if (it.mark === '-') {
      oldLines.push(it.text);
    } else if (it.mark === '+') {
      newLines.push({ mark: '+', text: it.text, oldIndex: -1 });
    }
  }
  return { oldLines, newLines };
}

/** True when a `\` line comes right after the body's last context or `+`
 * line. Only that marker decides whether a result that reaches the end of
 * the file keeps its final line break. */
function noBreakMarker(items: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].mark === ' ' || items[i].mark === '+') last = i;
  }
  if (last < 0) return false;
  return last + 1 < items.length && items[last + 1].mark === '\\';
}

/** The lines that replace a match: context lines are the file's own matched
 * lines; `+` lines are re-indented at tier 2 and written as they are at
 * tiers 0 and 1. */
function replacementLines(
  fresh: Split['newLines'],
  fileLines: string[],
  pos: number,
  tier: number,
  firstOld: string,
): string[] {
  const out: string[] = [];
  let fileIndent = '';
  let patchIndent = '';
  if (tier === 2) {
    fileIndent = indentOf(fileLines[pos]);
    patchIndent = indentOf(firstOld);
  }
  for (const it of fresh) {
    if (it.mark === ' ') {
      out.push(fileLines[pos + it.oldIndex]);
    } else if (tier === 2 && !/^[ \t]*$/.test(it.text) && it.text.startsWith(patchIndent)) {
      // Tier 2 only: shift the patch's indent to the file's indent. A line
      // that does not start with the patch indent keeps its own indent.
      out.push(fileIndent + it.text.slice(patchIndent.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

function toBodyLine(line: string): BodyLine {
  if (line === '') return { mark: ' ', text: '', empty: true };
  return { mark: line.charAt(0) as Mark, text: line.slice(1), empty: false };
}

function isBody(line: string): boolean {
  if (line === '') return true;
  const c = line.charAt(0);
  return c === ' ' || c === '-' || c === '+' || c === '\\';
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

type Hunk = {
  /** The `-A` number from the `@@` header. */
  start: number;
  items: BodyLine[];
};

type DiffSection = {
  oldPath: string | null; // null means /dev/null, i.e. no file
  newPath: string | null;
  paired: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
};

/** The path after `--- ` or `+++ `, cut at the first tab and trimmed, with
 * a leading `a/` or `b/` removed. `/dev/null` means no file (null). */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const GIT_DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseUnified(lines: string[], strict: boolean): Operation[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1].empty) {
        hunk.items.pop();
      }
      hunk = null;
    }
  };

  const openSection = (
    paired: boolean,
    oldP: string | null,
    newP: string | null,
    gitOld: string | null,
    gitNew: string | null,
  ): DiffSection => {
    const s: DiffSection = {
      oldPath: oldP,
      newPath: newP,
      paired,
      renameFrom: null,
      renameTo: null,
      gitOld,
      gitNew,
      created: false,
      deleted: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (hunk !== null) {
      // Inside a hunk body. A --- line followed by a +++ line ends the body
      // and starts a new section, even though it starts with '-'.
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (isBody(line)) {
        hunk.items.push(toBodyLine(line));
        i++;
        continue;
      }
      closeHunk();
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const m = GIT_DIFF_RE.exec(line);
      if (m === null) badPatch(i + 1);
      cur = openSection(false, null, null, m[1], m[2]);
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (cur === null) badPatch(i + 1);
      const m = HUNK_HEAD_RE.exec(line);
      if (m === null) badPatch(i + 1);
      hunk = { start: Number(m[1]), items: [] };
      cur.hunks.push(hunk);
      i++;
      continue;
    }

    if (line.startsWith('--- ')) {
      const plusNext = i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      if (cur !== null && cur.hunks.length === 0) {
        // Inside a section's header.
        if (plusNext) {
          if (!cur.paired) {
            cur.oldPath = headerPath(line);
            cur.newPath = headerPath(lines[i + 1]);
            cur.paired = true;
          }
          i += 2;
          continue;
        }
        badPatch(i + 2);
      }
      if (cur === null) {
        if (plusNext) {
          cur = openSection(true, headerPath(line), headerPath(lines[i + 1]), null, null);
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      // After hunks: a --- line followed by +++ starts a new section.
      if (plusNext) {
        cur = openSection(true, headerPath(line), headerPath(lines[i + 1]), null, null);
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (cur !== null && cur.hunks.length === 0) {
      // Header lines, before the first hunk.
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.created = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deleted = true;
      }
      // index, old/new mode, similarity/dissimilarity index, Index: and any
      // other line are ignored.
      i++;
      continue;
    }

    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  closeHunk();

  if (sections.length === 0) badPatch(1);
  return sections.map((s) => diffOperation(s, strict));
}

/** Apply one section's hunks to a file's text. Returns the new text, or
 * 'no-match' when a hunk fails to match. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean): string | 'no-match' {
  const doc = Doc.from(text);
  const lines = doc.lines;
  let terminated = doc.terminated;
  let shift = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = splitBody(h.items);
    const noBreak = noBreakMarker(h.items);
    if (oldLines.length === 0) {
      const before = lines.length;
      const at = Math.min(Math.max(h.start + shift, 0), before);
      const fresh = newLines.filter((it) => it.mark === '+').map((it) => it.text);
      lines.splice(at, 0, ...fresh);
      // An insertion at the end of the file ends with a line break unless a
      // \ line follows the hunk's last + line.
      if (at === before) terminated = !noBreak;
      shift += fresh.length;
      continue;
    }
    const found = tieredOccurrences(lines, oldLines, 0, strict);
    if (found === null) return 'no-match';
    const target = h.start - 1 + shift;
    let best = found.positions[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const reachesEnd = best + oldLines.length === lines.length;
    const fresh = replacementLines(newLines, lines, best, found.tier, oldLines[0]);
    lines.splice(best, oldLines.length, ...fresh);
    if (reachesEnd) terminated = !noBreak;
    shift += fresh.length - oldLines.length;
  }
  return new Doc(lines, doc.br, terminated).toString();
}

function diffOperation(sec: DiffSection, strict: boolean): Operation {
  return {
    run(files: Map<string, string>, moves: Array<[string, string]>): Failure | null {
      const oldP = sec.paired ? sec.oldPath : sec.renameFrom !== null ? sec.renameFrom : sec.gitOld;
      const newP = sec.paired ? sec.newPath : sec.renameTo !== null ? sec.renameTo : sec.gitNew;
      const creating = oldP === null || sec.created;
      const removing = !creating && (newP === null || sec.deleted);

      if (creating) {
        if (newP === null) return null; // both sides /dev/null: nothing to create
        const path = newP;
        if (!safePath(path)) return failWith('unsafe', path);
        if (files.has(path)) return failWith('exists', path);
        const added: string[] = [];
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.mark === '+') added.push(it.text);
          }
        }
        // A created file ends with a line break unless a \ line follows its
        // last + line.
        let noBreak = false;
        let lastPlus = -1;
        let lastHunk: Hunk | null = null;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.items.length; k++) {
            if (h.items[k].mark === '+') {
              lastPlus = k;
              lastHunk = h;
            }
          }
        }
        noBreak =
          lastHunk !== null &&
          lastPlus + 1 < lastHunk.items.length &&
          lastHunk.items[lastPlus + 1].mark === '\\';
        const text = added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n');
        files.set(path, text);
        return null;
      }

      if (removing) {
        if (oldP === null) return null; // both sides /dev/null: nothing to delete
        const path = oldP;
        if (!safePath(path)) return failWith('unsafe', path);
        if (!files.has(path)) return failWith('missing', path);
        files.delete(path);
        return null;
      }

      if (oldP !== newP) {
        // A move.
        const from = oldP as string;
        const to = newP as string;
        if (!safePath(from)) return failWith('unsafe', from);
        if (!safePath(to)) return failWith('unsafe', to);
        if (!files.has(from)) return failWith('missing', from);
        if (files.has(to)) return failWith('exists', to);
        const result = applyHunks(files.get(from) as string, sec.hunks, strict);
        if (result === 'no-match') return failWith('no-match', from);
        files.delete(from);
        files.set(to, result);
        moves.push([from, to]);
        return null;
      }

      // A change of the one path.
      const path = oldP as string;
      if (!safePath(path)) return failWith('unsafe', path);
      if (!files.has(path)) return failWith('missing', path);
      const result = applyHunks(files.get(path) as string, sec.hunks, strict);
      if (result === 'no-match') return failWith('no-match', path);
      files.set(path, result);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function isSearchMarker(line: string): boolean {
  return trimRight(line) === '<<<<<<< SEARCH';
}

function isSeparator(line: string): boolean {
  return trimRight(line) === '=======';
}

function isReplaceMarker(line: string): boolean {
  return trimRight(line) === '>>>>>>> REPLACE';
}

type SearchBlock = {
  path: string;
  oldLines: string[];
  newLines: string[];
};

function parseSearchReplace(lines: string[], strict: boolean): Operation[] {
  const blocks: SearchBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearchMarker(lines[i])) {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) badPatch(searchLine);
      path = prevPath;
    }
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (isSearchMarker(lines[k])) badPatch(searchLine);
      if (isReplaceMarker(lines[k])) badPatch(searchLine);
      if (isSeparator(lines[k])) {
        sep = k;
        break;
      }
    }
    if (sep === -1) badPatch(searchLine);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (isSearchMarker(lines[k])) badPatch(searchLine);
      if (isReplaceMarker(lines[k])) {
        rep = k;
        break;
      }
    }
    if (rep === -1) badPatch(searchLine);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) badPatch(1);
  return blocks.map((b) => searchOperation(b, strict));
}

function searchOperation(block: SearchBlock, strict: boolean): Operation {
  return {
    run(files: Map<string, string>): Failure | null {
      const path = block.path;
      if (!safePath(path)) return failWith('unsafe', path);
      if (block.oldLines.length === 0) {
        if (files.has(path)) return failWith('exists', path);
        const text = block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n';
        files.set(path, text);
        return null;
      }
      if (!files.has(path)) return failWith('missing', path);
      const doc = Doc.from(files.get(path) as string);
      const found = tieredOccurrences(doc.lines, block.oldLines, 0, strict);
      if (found === null) return failWith('no-match', path);
      if (found.positions.length > 1) return failWith('ambiguous', path);
      const pos = found.positions[0];
      const fresh = replacementLines(
        block.newLines.map((t) => ({ mark: '+' as const, text: t, oldIndex: -1 })),
        doc.lines,
        pos,
        found.tier,
        block.oldLines[0],
      );
      const lines = doc.lines.slice();
      lines.splice(pos, block.oldLines.length, ...fresh);
      files.set(path, new Doc(lines, doc.br, doc.terminated).toString());
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

type V4aChunk = {
  anchor: string | null;
  items: BodyLine[];
  eof: boolean;
};

type V4aSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function isV4aHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4a(lines: string[], strict: boolean): Operation[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) badPatch(1);
  if (lines[first].trim() !== '*** Begin Patch') badPatch(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') badPatch(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i])) i++;
    if (i >= last) break;
    const line = lines[i];
    const sectionLine = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      badPatch(sectionLine);
    }
    // Gather the section's lines, up to the next section or *** End Patch.
    const start = i + 1;
    let j = start;
    while (j < last && !isV4aHeader(lines[j])) j++;
    const content: Array<{ line: string; idx: number }> = [];
    for (let k = start; k < j; k++) content.push({ line: lines[k], idx: k });
    // Blank lines at the end of a section are not part of it.
    while (content.length > 0 && isBlank(content[content.length - 1].line)) content.pop();

    if (kind === 'add') {
      const out: string[] = [];
      for (const c of content) {
        if (c.line === '') out.push('');
        else if (c.line.charAt(0) === '+') out.push(c.line.slice(1));
        else badPatch(c.idx + 1);
      }
      sections.push({ kind: 'add', path, content: out });
    } else if (kind === 'delete') {
      if (content.length > 0) badPatch(content[0].idx + 1);
      sections.push({ kind: 'delete', path });
    } else {
      let p = 0;
      let moveTo: string | null = null;
      if (p < content.length && content[p].line.startsWith('*** Move to: ')) {
        moveTo = content[p].line.slice('*** Move to: '.length).trim();
        p++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let sawChunk = false;
      while (p < content.length) {
        const c = content[p];
        const l = c.line;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), items: [], eof: false };
          chunks.push(cur);
          sawChunk = true;
          p++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) badPatch(c.idx + 1);
          cur.eof = true;
          cur = null;
          p++;
          continue;
        }
        if (l === '' || l.charAt(0) === ' ' || l.charAt(0) === '-' || l.charAt(0) === '+') {
          if (cur === null) {
            if (sawChunk) badPatch(c.idx + 1);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
            sawChunk = true;
          }
          cur.items.push(toBodyLine(l));
          p++;
          continue;
        }
        badPatch(c.idx + 1);
      }
      if (chunks.length === 0 && moveTo === null) badPatch(sectionLine);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
    i = j;
  }
  if (sections.length === 0) badPatch(1);
  return sections.map((s) => v4aOperation(s, strict));
}

/** Apply one Update File section's chunks to a file's text. */
function applyV4aChunks(text: string, chunks: V4aChunk[], strict: boolean): string | 'no-match' {
  const doc = Doc.from(text);
  const lines = doc.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      const at = singleOccurrence(lines, ch.anchor, cursor, strict);
      if (at === -1) return 'no-match';
      cursor = at + 1;
    }
    const { oldLines, newLines } = splitBody(ch.items);
    if (oldLines.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const fresh = newLines.filter((it) => it.mark === '+').map((it) => it.text);
      lines.splice(at, 0, ...fresh);
      cursor = at + fresh.length;
      continue;
    }
    const found = tieredOccurrences(lines, oldLines, cursor, strict);
    if (found === null) return 'no-match';
    const pos = found.positions[0];
    if (ch.eof && pos + oldLines.length !== lines.length) return 'no-match';
    const fresh = replacementLines(newLines, lines, pos, found.tier, oldLines[0]);
    lines.splice(pos, oldLines.length, ...fresh);
    cursor = pos + fresh.length;
  }
  return new Doc(lines, doc.br, doc.terminated).toString();
}

function v4aOperation(sec: V4aSection, strict: boolean): Operation {
  return {
    run(files: Map<string, string>, moves: Array<[string, string]>): Failure | null {
      if (sec.kind === 'add') {
        if (!safePath(sec.path)) return failWith('unsafe', sec.path);
        if (files.has(sec.path)) return failWith('exists', sec.path);
        const text = sec.content.length === 0 ? '' : sec.content.join('\n') + '\n';
        files.set(sec.path, text);
        return null;
      }
      if (sec.kind === 'delete') {
        if (!safePath(sec.path)) return failWith('unsafe', sec.path);
        if (!files.has(sec.path)) return failWith('missing', sec.path);
        files.delete(sec.path);
        return null;
      }
      // Update File.
      if (!safePath(sec.path)) return failWith('unsafe', sec.path);
      if (sec.moveTo !== null && !safePath(sec.moveTo)) return failWith('unsafe', sec.moveTo);
      if (!files.has(sec.path)) return failWith('missing', sec.path);
      if (sec.moveTo !== null && files.has(sec.moveTo)) return failWith('exists', sec.moveTo);
      const result = applyV4aChunks(files.get(sec.path) as string, sec.chunks, strict);
      if (result === 'no-match') return failWith('no-match', sec.path);
      if (sec.moveTo !== null) {
        files.delete(sec.path);
        files.set(sec.moveTo, result);
        moves.push([sec.path, sec.moveTo]);
      } else {
        files.set(sec.path, result);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

type JsonEdit =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function checkJsonEdit(obj: unknown): JsonEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    let newStr = '';
    if (o.new_str !== undefined) {
      if (typeof o.new_str !== 'string') return null;
      newStr = o.new_str;
    }
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Operation[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) badPatch(1);
  const edits: JsonEdit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the array's line.
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      badPatch(first + 1);
    }
    if (!Array.isArray(arr)) badPatch(first + 1);
    for (const obj of arr) {
      const e = checkJsonEdit(obj);
      if (e === null) badPatch(first + 1);
      edits.push(e);
    }
  } else {
    // JSON Lines: one edit object a line, blank lines ignored.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isBlank(line)) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        badPatch(i + 1);
      }
      const e = checkJsonEdit(obj);
      if (e === null) badPatch(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) badPatch(1);
  return edits.map((e) => jsonOperation(e));
}

/** Split an insert's new_str the way the spec says: at `\n`, each line with
 * one trailing `\r` removed, without the empty piece after a final `\n`. */
function splitInserted(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function jsonOperation(e: JsonEdit): Operation {
  return {
    run(files: Map<string, string>): Failure | null {
      if (!safePath(e.path)) return failWith('unsafe', e.path);
      if (e.kind === 'create') {
        if (files.has(e.path)) return failWith('exists', e.path);
        files.set(e.path, e.fileText);
        return null;
      }
      if (!files.has(e.path)) return failWith('missing', e.path);
      if (e.kind === 'str_replace') {
        const text = files.get(e.path) as string;
        const doc = Doc.from(text);
        let hay = text;
        let oldStr = e.oldStr;
        let newStr = e.newStr;
        if (doc.br === '\r\n') {
          hay = text.replace(/\r\n/g, '\n');
          oldStr = oldStr.replace(/\r\n/g, '\n');
          newStr = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let at = 0;
        let foundAt = -1;
        for (;;) {
          const p = hay.indexOf(oldStr, at);
          if (p === -1) break;
          count++;
          foundAt = p;
          at = p + 1;
        }
        if (count === 0) return failWith('no-match', e.path);
        if (count > 1) return failWith('ambiguous', e.path);
        let result = hay.slice(0, foundAt) + newStr + hay.slice(foundAt + oldStr.length);
        if (doc.br === '\r\n') result = result.replace(/\n/g, '\r\n');
        files.set(e.path, result);
        return null;
      }
      // insert
      const text = files.get(e.path) as string;
      const doc = Doc.from(text);
      if (e.insertLine < 0 || e.insertLine > doc.lines.length) {
        return failWith('no-match', e.path);
      }
      const ins = splitInserted(e.newStr);
      const lines = doc.lines.slice();
      lines.splice(e.insertLine, 0, ...ins);
      files.set(e.path, new Doc(lines, doc.br, doc.terminated).toString());
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first !== -1) {
    if (lines[first].trim() === '*** Begin Patch') return 'v4a';
    const c = lines[first].trimStart().charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const line of lines) {
    if (trimRight(line) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree snapshot and output
// ---------------------------------------------------------------------------

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dir);
  return out;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The output lines for a successful run, in byte order of the paths. */
function reportLines(
  initial: Map<string, string>,
  tree: Map<string, string>,
  moves: Array<[string, string]>,
): string[] {
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [p, t] of initial) {
    if (!tree.has(p)) deleted.add(p);
    else if (tree.get(p) !== t) modified.add(p);
  }
  for (const p of tree.keys()) {
    if (!initial.has(p)) added.add(p);
  }
  const items: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of moves) {
    if (deleted.has(oldP) && added.has(newP)) {
      deleted.delete(oldP);
      added.delete(newP);
      items.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of deleted) items.push({ key: p, line: `D ${p}` });
  for (const p of added) items.push({ key: p, line: `A ${p}` });
  for (const p of modified) items.push({ key: p, line: `M ${p}` });
  items.sort((a, b) => byteOrder(a.key, b.key));
  return items.map((it) => it.line);
}

/** Write the final tree: deletions first, then changed and created files. */
function writeTree(initial: Map<string, string>, tree: Map<string, string>): void {
  for (const p of initial.keys()) {
    if (!tree.has(p)) rmSync(p, { force: true });
  }
  const paths = [...tree.keys()].sort(byteOrder);
  for (const p of paths) {
    if (initial.get(p) === tree.get(p)) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, tree.get(p) as string, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Command line (SPEC section 1)
// ---------------------------------------------------------------------------

type CliOptions = {
  format: FormatName | 'auto';
  check: boolean;
  strict: boolean;
  patch: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  let format: FormatName | 'auto' = 'auto';
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (checkSeen) badUsage();
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) badUsage();
        strictSeen = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (formatSeen) badUsage();
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v === 'unified' || v === 'search-replace' || v === 'v4a' || v === 'json' || v === 'auto') {
          format = v;
        } else {
          badUsage();
        }
      } else {
        badUsage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) badUsage();
  return { format, check, strict, patch: positional.length === 0 ? null : positional[0] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof BadUsage) {
      process.stdout.write('error: usage\n');
      return 2;
    }
    throw err;
  }

  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }

  const lines = patchLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = detected;
  }

  let edits: Operation[];
  try {
    if (format === 'unified') edits = parseUnified(lines, opts.strict);
    else if (format === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else if (format === 'v4a') edits = parseV4a(lines, opts.strict);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof BadPatch) {
      process.stdout.write(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }

  const initial = readTree('.');
  const tree = new Map(initial);
  const moves: Array<[string, string]> = [];
  const failures: Failure[] = [];
  for (const edit of edits) {
    const fail = edit.run(tree, moves);
    if (fail !== null) failures.push(fail);
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }

  const changed = reportLines(initial, tree, moves);
  if (!opts.check) writeTree(initial, tree);
  let out = '';
  for (const line of changed) out += line + '\n';
  out += changed.length === 1 ? 'ok: 1 file\n' : `ok: ${changed.length} files\n`;
  process.stdout.write(out);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  if (process.env.MAKEFUN_ENV_URL) {
    // In a trial, hand over to the kit's runner, which reads the checks from
    // the env, runs this CLI on each one, and posts the results.
    const { runTrial } = await import('./runner.ts');
    await runTrial(process.env.MAKEFUN_ENV_URL);
  } else {
    process.exitCode = runCli(process.argv.slice(2));
  }
} catch (err) {
  process.stderr.write(String((err as Error)?.stack ?? err) + '\n');
  process.exitCode = 2;
}
