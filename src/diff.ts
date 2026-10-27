import { ChangeSet, type ChangeSpec, Text } from '@codemirror/state';

/** Past this many inserted or deleted lines the diff gives up and replaces one span, as a full rewrite would. */
const MAX_COST = 1000;

/** [aFrom, aTo, bFrom, bTo]: lines aFrom..aTo of `a` become lines bFrom..bTo of `b`. */
type Hunk = [number, number, number, number];

/** Lines with their line breaks, so equal lines are equal including whether they end the text. */
function splitLines(text: string): string[] {
  return text ? text.split(/(?<=\n)/) : [];
}

/** Myers' O(ND) diff over line ids. Returns null when more than `max` lines change. */
function myers(a: Int32Array, b: Int32Array, max: number): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): Hunk[] {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    // One line inserted (x unchanged) or deleted, merged into the hunk that follows it.
    const last = hunks[hunks.length - 1];
    if (last && last[0] === x && last[2] === y) {
      last[0] = prevX;
      last[2] = prevY;
    } else {
      hunks.push([prevX, x, prevY, y]);
    }
    x = prevX;
    y = prevY;
  }
  return hunks.reverse();
}

/** Line hunks between `a` and `b`, with the unchanged lines at both ends trimmed first. */
function lineHunks(a: string[], b: string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let value = ids.get(line);
    if (value === undefined) ids.set(line, (value = ids.size));
    return value;
  };
  const idsA = Int32Array.from(a.slice(start, endA), id);
  const idsB = Int32Array.from(b.slice(start, endB), id);
  const hunks = myers(idsA, idsB, Math.min(MAX_COST, idsA.length + idsB.length)) ?? [
    [0, idsA.length, 0, idsB.length],
  ];
  return slideUp(
    a,
    hunks.map(([fa, ta, fb, tb]) => [fa + start, ta + start, fb + start, tb + start]),
    b,
  );
}

/**
 * Lines added or removed next to equal lines can be placed in more than one
 * spot ("\n" + "new\n" or "new\n" + "\n"). Moving them up as far as they go
 * keeps them off the start of the line that follows, so a cursor there stays
 * with its line instead of ending up in front of the new text.
 */
function slideUp(a: string[], hunks: Hunk[], b: string[]): Hunk[] {
  let floorA = 0;
  let floorB = 0;
  for (const hunk of hunks) {
    let [fa, ta, fb, tb] = hunk;
    if (fa === ta) {
      while (fa > floorA && fb > floorB && a[fa - 1] === b[tb - 1]) {
        fa--;
        ta--;
        fb--;
        tb--;
      }
    } else if (fb === tb) {
      while (fa > floorA && fb > floorB && a[fa - 1] === a[ta - 1]) {
        fa--;
        ta--;
        fb--;
        tb--;
      }
    }
    hunk.splice(0, 4, fa, ta, fb, tb);
    floorA = ta;
    floorB = tb;
  }
  return hunks;
}

function lineStarts(lines: string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length);
  return starts;
}

/**
 * The changes that turn `a` into `b`, one per changed region, each trimmed
 * to the characters that differ. Text outside them keeps its positions, so a
 * cursor or a rendered block between two outside edits stays where it is.
 */
export function diffToChanges(a: string, b: string): ChangeSet {
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  const startsA = lineStarts(linesA);
  const startsB = lineStarts(linesB);
  const specs: ChangeSpec[] = [];
  for (const [fa, ta, fb, tb] of lineHunks(linesA, linesB)) {
    let from = startsA[fa];
    let to = startsA[ta];
    let insertFrom = startsB[fb];
    let insertTo = startsB[tb];
    while (from < to && insertFrom < insertTo && a.charCodeAt(from) === b.charCodeAt(insertFrom)) {
      from++;
      insertFrom++;
    }
    while (to > from && insertTo > insertFrom && a.charCodeAt(to - 1) === b.charCodeAt(insertTo - 1)) {
      to--;
      insertTo--;
    }
    specs.push({ from, to, insert: b.slice(insertFrom, insertTo) });
  }
  return ChangeSet.of(specs, a.length);
}

/** How many characters a change set deletes and inserts. */
export function changeSize(changes: ChangeSet): number {
  let size = 0;
  changes.iterChanges((fromA, toA, fromB, toB) => {
    size += toA - fromA + (toB - fromB);
  });
  return size;
}

/**
 * Three-way merge: `mine` and `theirs` both started from `base`. Their
 * changes are taken as they are and mine are moved over them, the way the
 * collab protocol rebases a client's unconfirmed edits. Nothing either side
 * typed is dropped; where both changed the same text, both versions stay.
 */
export function merge(base: string, mine: string, theirs: string): string {
  const ours = diffToChanges(base, mine);
  const other = diffToChanges(base, theirs);
  return ours.map(other).apply(Text.of(theirs.split('\n'))).toString();
}

export type DiskState = 'same' | 'ours' | 'reloading' | 'outside';

/**
 * What a file on disk means for its open document: the same text, a save of
 * an earlier version of it, a change VS Code is about to load because the
 * document is clean, or an outside change VS Code will ignore because the
 * document has unsaved edits.
 */
export function classify(disk: string, current: string, dirty: boolean, recent: Iterable<string>): DiskState {
  if (disk === current) return 'same';
  if (!dirty) return 'reloading';
  for (const text of recent) if (text === disk) return 'ours';
  return 'outside';
}

/**
 * The known text an outside write most likely started from: the one it
 * differs from least. An agent edits the file as it was last saved, so this
 * finds that save even when its watcher event was folded into the write.
 */
export function closestBase(disk: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestSize = Infinity;
  for (const candidate of candidates) {
    const size = changeSize(diffToChanges(candidate, disk));
    if (size < bestSize) {
      best = candidate;
      bestSize = size;
    }
  }
  return best;
}
