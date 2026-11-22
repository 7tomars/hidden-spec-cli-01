// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what changed or why it failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at `\n`, one trailing `\r` removed from each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into its lines: CRLF when its first line feed follows a carriage return, LF otherwise. */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}
/** A text's line break (section 3): CRLF when its first line feed follows a carriage return, LF otherwise. */
function lineBreakOf(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function splitLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const br = lineBreakOf(text);
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, br, finalBreak };
}
function joinLines(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  final(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Check a path an edit names for safety before anything else about it (SPEC.md sections 3 and 10). */
function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------- matching (SPEC.md section 5)

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? rtrimST(a) === rtrimST(b) : trimST(a) === trimST(b);
}

/** Every position at which O occurs in lines at the given tier, overlapping occurrences included. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  const k = O.length;
  for (let i = from; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, and its occurrences there. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, O, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** At tier 2 a non-context line of N that starts with O's first line's indent P has that P replaced by F. */
function reindent(line: string, F: string, P: string): string {
  if (line === '' || trimST(line) === '') return line;
  return line.startsWith(P) ? F + line.slice(P.length) : line;
}

interface Entry {
  kind: string; // ' ' context, '-' old, '+' new
  text: string;
  bare?: boolean; // an empty patch line read as an empty context line
  noEol?: boolean; // a `\` line follows this body line
  oIdx?: number; // this entry's index among O's lines
}

/** O: the context and `-` lines of a hunk or chunk, in body order. Sets each entry's oIdx. */
function oldOf(entries: Entry[]): string[] {
  const O: string[] = [];
  for (const e of entries) {
    if (e.kind !== '+') {
      e.oIdx = O.length;
      O.push(e.text);
    }
  }
  return O;
}

/** The lines N writes for a match at pos: context lines are the file's own, the rest as written (tier 2 re-indents). */
function renderN(entries: Entry[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const F = leadWS(fileLines[pos]!);
  const P = leadWS(O[0]!);
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === '-') continue;
    if (e.kind === ' ') out.push(fileLines[pos + e.oIdx!]!);
    else out.push(tier === 2 ? reindent(e.text, F, P) : e.text);
  }
  return out;
}

// ---------------------------------------------------------------- format detection (section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  entries: Entry[];
}
interface Section {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path on a `--- `/`+++ ` line: after the four characters, up to the first tab, spaces removed, prefix removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (cur === null || cur.hunks.length > 0)) {
      cur = newSection();
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      if (!line.startsWith('@@')) {
        i += 1; // any other header line is ignored
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: Entry[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          entries.push({ kind: ' ', text: '', bare: true });
          i += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          entries.push({ kind: c, text: l.slice(1) });
          i += 1;
          continue;
        }
        if (c === '\\') {
          if (entries.length > 0) entries[entries.length - 1]!.noEol = true;
          i += 1;
          continue;
        }
        break;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.bare) entries.pop();
      cur.hunks.push({ a: Number(m[1]), entries });
      continue;
    }
    i += 1; // outside bodies, lines that are not part of a section header are ignored
  }
  return sections.map((s) => unifiedEdit(s));
}

/** Apply a section's hunks in order to a file's text; returns the new lines and final-break state. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileLines {
  const f = splitLines(text);
  const lines = f.lines;
  let fb = f.finalBreak;
  let d = 0;
  for (const hunk of hunks) {
    const O = oldOf(hunk.entries);
    const nSide = hunk.entries.filter((e) => e.kind !== '-');
    if (O.length === 0) {
      const pos = Math.min(hunk.a + d, lines.length);
      const texts = nSide.map((e) => e.text);
      if (pos === lines.length && nSide.length > 0) fb = !nSide[nSide.length - 1]!.noEol;
      lines.splice(pos, 0, ...texts);
      d += texts.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const written = renderN(hunk.entries, O, lines, pos, found.tier);
    const reachesEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...written);
    if (reachesEnd) {
      const last = nSide[nSide.length - 1];
      fb = last === undefined ? true : !last.noEol;
    }
    d += written.length - O.length;
  }
  return { lines, br: f.br, finalBreak: fb };
}

function unifiedEdit(sec: Section): Edit {
  return (tree) => {
    let oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    let newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    if (oldP === undefined) oldP = newP;
    if (newP === undefined) newP = oldP;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (oldP != null) checkSafe(oldP);
    if (newP != null) checkSafe(newP);
    if (isCreate) {
      const p = (newP ?? oldP)!;
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: Entry[] = [];
      for (const h of sec.hunks) for (const e of h.entries) if (e.kind === '+') plus.push(e);
      const fb = plus.length === 0 ? true : !plus[plus.length - 1]!.noEol;
      tree.now.set(p, joinLines(plus.map((e) => e.text), '\n', fb));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const r = applyHunks(tree.get(oldP!)!, sec.hunks, STRICT, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, joinLines(r.lines, r.br, r.finalBreak));
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const r = applyHunks(tree.get(p)!, sec.hunks, STRICT, p);
    tree.now.set(p, joinLines(r.lines, r.br, r.finalBreak));
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinLines(newLines, '\n', true));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitLines(text);
    const found = findTier(f.lines, oldLines, STRICT);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    let written = newLines;
    if (found.tier === 2) {
      const F = leadWS(f.lines[pos]!);
      const P = leadWS(oldLines[0]!);
      written = newLines.map((l) => reindent(l, F, P));
    }
    const out = [...f.lines.slice(0, pos), ...written, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinLines(out, f.br, f.finalBreak));
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  entries: Entry[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: [string, VSection['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'delete'],
    ['*** Update File: ', 'update'],
  ];
  const headOf = (l: string): { kind: VSection['kind']; prefix: string } | null => {
    for (const [prefix, kind] of heads) if (l.startsWith(prefix)) return { kind, prefix };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const h = headOf(line);
    if (h === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = {
      kind: h.kind,
      path: line.slice(h.prefix.length).trim(),
      headerLine: i + 1,
      addLines: [],
      moveTo: null,
      chunks: [],
    };
    // Collect the section's lines, up to the next section header or the End Patch line.
    const body: { idx: number; text: string }[] = [];
    let j = i + 1;
    while (j < last && headOf(lines[j]!) === null) {
      body.push({ idx: j, text: lines[j]! });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (sec.kind === 'add') {
      for (const b of body) {
        if (b.text.startsWith('+')) sec.addLines.push(b.text.slice(1));
        else if (b.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
    } else if (sec.kind === 'delete') {
      for (const b of body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.idx + 1}`);
      }
    } else {
      parseV4aUpdate(sec, body);
    }
    sections.push(sec);
    i = j;
  }
  return sections.map((s) => v4aEdit(s));
}

function parseV4aUpdate(sec: VSection, body: { idx: number; text: string }[]): void {
  let k = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    sec.moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  let cur: Chunk | null = null;
  let closed = false;
  for (; k < body.length; k += 1) {
    const b = body[k]!;
    const l = b.text;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), entries: [], eof: false };
      sec.chunks.push(cur);
      closed = false;
      continue;
    }
    if (l.trimEnd() === '*** End of File') {
      if (cur === null || closed) throw new Exit2(`error: parse ${b.idx + 1}`);
      cur.eof = true;
      closed = true;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${b.idx + 1}`);
        cur = { anchor: null, entries: [], eof: false };
        sec.chunks.push(cur);
        closed = false;
      }
      if (closed) throw new Exit2(`error: parse ${b.idx + 1}`);
      cur.entries.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${b.idx + 1}`);
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headerLine}`);
}

function v4aEdit(sec: VSection): Edit {
  return (tree) => {
    checkSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinLines(sec.addLines, '\n', true));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) checkSafe(sec.moveTo);
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitLines(text);
    const lines = f.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = STRICT ? [0] : [0, 1, 2];
        let at = -1;
        for (const t of tiers) {
          for (let x = cursor; x < lines.length; x += 1) {
            if (lineEq(lines[x]!, chunk.anchor, t)) {
              at = x;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const O = oldOf(chunk.entries);
      if (O.length === 0) {
        const nSide = chunk.entries.filter((e) => e.kind !== '-');
        const pos = chunk.eof ? lines.length : cursor;
        lines.splice(pos, 0, ...nSide.map((e) => e.text));
        cursor = pos + nSide.length;
        continue;
      }
      const tiers = STRICT ? [0] : [0, 1, 2];
      let hit: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        const positions = occurrences(lines, O, t, cursor).filter((p) => !chunk.eof || p + O.length === lines.length);
        if (positions.length > 0) {
          hit = { tier: t, pos: positions[0]! };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', sec.path);
      const written = renderN(chunk.entries, O, lines, hit.pos, hit.tier);
      lines.splice(hit.pos, O.length, ...written);
      cursor = hit.pos + written.length;
    }
    const out = joinLines(lines, f.br, f.finalBreak);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    checkSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const crlf = lineBreakOf(before) === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitLines(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const out = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.now.set(p, joinLines(out, f.br, f.finalBreak));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- the run (sections 1, 2 and 10)

let STRICT = false;

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines)
          : kind === 'search-replace'
            ? parseSearchReplace(lines)
            : parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // What changed, path by path; a successful move replaces its pair's D and A lines with one R line.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.final(o) === null && tree.original(n) === null && tree.final(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
