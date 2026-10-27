import { syntaxTree } from '@codemirror/language';
import { type ChangeSpec, countColumn, EditorSelection, type EditorState, type Line } from '@codemirror/state';
import { type Command, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { MarkdownConfig } from '@lezer/markdown';

const LISTS = new Set(['BulletList', 'OrderedList']);
/** Blocks whose lines are not list text, so Tab keeps its plain meaning there. */
const VERBATIM = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'Table', 'CommentBlock']);
const ORDERED = /^(\d+)([.)])$/;
const EMPTY_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

/**
 * Inside a list, a bare `- ` or `1. ` line starts an item even right under
 * a paragraph. Lezer already allows that for bullets inside bullet lists;
 * without it, a fresh bullet under a numbered item would turn the item's
 * text into a setext heading, and a fresh `1.` under a bullet would just
 * continue the text.
 */
export const EmptyListItems: MarkdownConfig = {
  parseBlock: [
    {
      name: 'EmptyListItem',
      endLeaf(cx, line) {
        if (!EMPTY_MARKER.test(line.text.slice(line.pos))) return false;
        for (let depth = cx.depth - 1; depth >= 0; depth--) if (cx.parentType(depth).name === 'ListItem') return true;
        return false;
      },
    },
  ],
};

/** The list item whose marker is on the given line (the outermost one for `- - x`). */
function itemOnLine(state: EditorState, from: number, to: number): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (found) return false;
      if (node.name === 'ListMark' && node.from >= from && node.to <= to) {
        found = node.node.parent;
        return false;
      }
    },
  });
  return found;
}

/** The list item a line belongs to: the one its marker starts, or the one whose text it continues. */
function itemForLine(state: EditorState, line: Line): SyntaxNode | null {
  const marked = itemOnLine(state, line.from, line.to);
  if (marked || !line.text.trim()) return marked;
  const start = line.from + /^[\s>]*/.exec(line.text)![0].length;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(start, 1); node; node = node.parent) {
    if (node.name === 'ListItem') return node;
    if (VERBATIM.has(node.name)) return null;
  }
  return null;
}

/** Length of the block quote markup (`> `) that a list inside `depth` quotes sits behind. */
function containerPrefix(text: string, depth: number): number {
  let at = 0;
  for (let i = 0; i < depth; i++) {
    const match = /^[ \t]*>[ \t]?/.exec(text.slice(at));
    if (!match) break;
    at += match[0].length;
  }
  return at;
}

/**
 * A list item in the editable model of a list block. Edits never move
 * lines; they only change indentation and markers, so every item keeps
 * its lines and only its column and marker are recomputed.
 */
interface Entry {
  mark: SyntaxNode;
  line: Line;
  /** The marker shares its line with the parent's marker, as in `- - x`. */
  inline: boolean;
  /** Marker column, after any quote markup. */
  col: number;
  marker: string;
  /** `-`, `*` or `+` for bullets, `.` or `)` for ordered items. */
  kind: string;
  readonly originalKind: string;
  number: number | null;
  /** Columns between the marker and the item text. */
  gap: number;
  /** Marker column relative to the parent's text column (or the container, at the top level). */
  rel: number;
  lastLine: number;
  /** Lines of the item's own text after its marker line, excluding sublists. */
  body: number[];
  children: Entry[];
  parent: Entry | null;
  /** The item before this one in its original list. */
  readonly originalPrev: Entry | null;
  moved: boolean;
  /** Starts a new list even if the previous item has the same kind. */
  breakBefore: boolean;
  /** Marker typed over this item's marker, which replaces it. */
  typed: string | null;
}

function kindOf(marker: string): string {
  return ORDERED.exec(marker)?.[2] ?? marker;
}

const isOrdered = (kind: string) => kind === '.' || kind === ')';
const textColumn = (entry: Entry, col: number, marker: string) => col + marker.length + entry.gap;

/**
 * All lists that follow each other in one container (a bullet list right
 * after a numbered one reads as a single list), with their nested lists.
 */
class ListBlock {
  readonly roots: Entry[] = [];
  private readonly byMark = new Map<number, Entry>();
  private readonly depth: number;

  static around(state: EditorState, item: SyntaxNode): ListBlock {
    let list = item.parent!;
    while (list.parent?.name === 'ListItem') list = list.parent.parent!;
    const lists = [list];
    for (let node = list.prevSibling; node && (LISTS.has(node.name) || node.name === 'QuoteMark'); node = node.prevSibling) {
      if (LISTS.has(node.name)) lists.unshift(node);
    }
    for (let node = list.nextSibling; node && (LISTS.has(node.name) || node.name === 'QuoteMark'); node = node.nextSibling) {
      if (LISTS.has(node.name)) lists.push(node);
    }
    let depth = 0;
    for (let node = list.parent; node; node = node.parent) if (node.name === 'Blockquote') depth++;
    return new ListBlock(state, lists, depth);
  }

  private constructor(
    readonly state: EditorState,
    lists: SyntaxNode[],
    depth: number,
  ) {
    this.depth = depth;
    for (const list of lists) this.collect(list, null, this.roots);
  }

  get key(): number {
    return this.roots[0]?.mark.from ?? -1;
  }

  private collect(list: SyntaxNode, parent: Entry | null, into: Entry[]): void {
    const doc = this.state.doc;
    let prev: Entry | null = null;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      const mark = item.name === 'ListItem' ? item.getChild('ListMark') : null;
      if (!mark) continue;
      const line = doc.lineAt(mark.from);
      const lead = line.text.slice(containerPrefix(line.text, this.depth), mark.from - line.from);
      const marker = doc.sliceString(mark.from, mark.to);
      const after = line.text.slice(mark.to - line.from);
      const spaces = countColumn(/^[ \t]*/.exec(after)![0], 4);
      // An item that starts blank, or with code, has its text one column after the marker.
      const gap = !after.trim() || spaces > 4 ? 1 : spaces;
      const col = countColumn(lead, 4);
      const entry: Entry = {
        mark,
        line,
        inline: /\S/.test(lead),
        col,
        marker,
        kind: kindOf(marker),
        originalKind: kindOf(marker),
        number: ORDERED.test(marker) ? Number(ORDERED.exec(marker)![1]) : null,
        gap,
        rel: Math.max(0, col - (parent ? textColumn(parent, parent.col, parent.marker) : 0)),
        lastLine: doc.lineAt(Math.max(mark.from, item.to - 1)).number,
        body: [],
        children: [],
        parent,
        originalPrev: prev,
        moved: false,
        breakBefore: false,
        typed: null,
      };
      into.push(entry);
      this.byMark.set(mark.from, entry);
      prev = entry;
      for (let sub = item.firstChild; sub; sub = sub.nextSibling) {
        if (LISTS.has(sub.name)) this.collect(sub, entry, entry.children);
      }
      for (let n = line.number + 1; n <= entry.lastLine; n++) {
        if (entry.children.some((child) => n >= child.line.number && n <= child.lastLine)) continue;
        const text = doc.line(n).text;
        if (text.slice(containerPrefix(text, this.depth)).trim()) entry.body.push(n);
      }
    }
  }

  /** The entry for a list item; for `- - x` that is the outer item, which owns the line, unless `exact`. */
  entry(item: SyntaxNode, exact = false): Entry | null {
    const mark = item.getChild('ListMark');
    let entry = mark ? (this.byMark.get(mark.from) ?? null) : null;
    while (!exact && entry?.inline && entry.parent) entry = entry.parent;
    return entry;
  }

  /** Length of the quote markup in front of a line of this block. */
  prefix(line: Line): number {
    return containerPrefix(line.text, this.depth);
  }

  contains(ancestor: Entry, entry: Entry): boolean {
    for (let parent = entry.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
    return false;
  }

  private siblings(entry: Entry): Entry[] {
    return entry.parent ? entry.parent.children : this.roots;
  }

  private endLine(entry: Entry): number {
    return Math.max(entry.lastLine, ...entry.children.map((child) => this.endLine(child)));
  }

  /** Whether `b` directly follows `a` in their parent, with none of the parent's own text between them. */
  private adjacent(parent: Entry | null, a: Entry, b: Entry): boolean {
    const end = this.endLine(a);
    return !parent || !parent.body.some((n) => n > end && n < b.line.number);
  }

  /** Nests an item under the previous one, joining that item's sublist if it has one. */
  indent(entry: Entry): boolean {
    const siblings = this.siblings(entry);
    const index = siblings.indexOf(entry);
    if (index <= 0) return false;
    const prev = siblings[index - 1];
    siblings.splice(index, 1);
    const last = prev.children[prev.children.length - 1];
    if (last && this.adjacent(prev, last, entry)) {
      entry.rel = last.rel;
      entry.kind = last.kind;
    } else {
      entry.rel = 0;
    }
    prev.children.push(entry);
    entry.parent = prev;
    entry.moved = true;
    return true;
  }

  /**
   * Moves an item out to its parent's level, right after the parent and in
   * the parent's list. The items that followed it become its children, so
   * they stay where they are on screen.
   */
  outdent(entry: Entry): boolean {
    const parent = entry.parent;
    if (!parent) return false;
    const following = parent.children.splice(parent.children.indexOf(entry)).slice(1);
    for (const child of following) child.parent = entry;
    entry.children.push(...following);
    const outer = this.siblings(parent);
    outer.splice(outer.indexOf(parent) + 1, 0, entry);
    entry.parent = parent.parent;
    entry.rel = parent.rel;
    entry.kind = parent.kind;
    entry.moved = true;
    return true;
  }

  /** Drops an item from the model; with `split`, the items after it start a list of their own. */
  remove(entry: Entry, split: boolean): void {
    const siblings = this.siblings(entry);
    const index = siblings.indexOf(entry);
    siblings.splice(index, 1);
    if (split && siblings[index]) siblings[index].breakBefore = true;
  }

  /** The changes that bring the document in line with the model. */
  changes(): ChangeSpec[] {
    const changes: ChangeSpec[] = [];
    this.place(this.roots, null, 0, changes);
    return changes;
  }

  private place(entries: Entry[], parent: Entry | null, base: number, changes: ChangeSpec[]): void {
    // Consecutive items of one kind form a list; lists whose items moved are renumbered.
    const runs: Entry[][] = [];
    for (const entry of entries) {
      const run = runs[runs.length - 1];
      const last = run?.[run.length - 1];
      if (last && !entry.breakBefore && entry.kind === last.kind && this.adjacent(parent, last, entry)) run.push(entry);
      else runs.push([entry]);
    }
    const markers = new Map<Entry, string>();
    for (const run of runs) {
      const dirty = run.some(
        (entry, i) =>
          entry.moved || entry.typed !== null || entry.kind !== entry.originalKind || (run[i - 1] ?? null) !== entry.originalPrev,
      );
      const first = run[0];
      let number = first.typed !== null ? Number(first.typed.slice(0, -1)) : first.originalPrev ? 1 : (first.number ?? 1);
      for (const entry of run) {
        if (!dirty) markers.set(entry, entry.marker);
        else if (isOrdered(entry.kind)) markers.set(entry, `${number++}${entry.kind}`);
        else markers.set(entry, entry.kind);
      }
    }

    for (const entry of entries) {
      const marker = markers.get(entry)!;
      const col = base + entry.rel;
      if (!entry.inline) this.shift(entry.line, col - entry.col, changes);
      if (marker !== entry.marker) changes.push({ from: entry.mark.from, to: entry.mark.to, insert: marker });
      const text = textColumn(entry, col, marker);
      const delta = text - textColumn(entry, entry.col, entry.marker);
      for (const n of entry.body) this.shift(this.state.doc.line(n), delta, changes);
      this.place(entry.children, entry, text, changes);
    }
  }

  /** Indents or dedents a line by `delta` columns, behind any quote markup. */
  private shift(line: Line, delta: number, changes: ChangeSpec[]): void {
    if (!delta) return;
    const at = line.from + containerPrefix(line.text, this.depth);
    if (delta > 0) {
      changes.push({ from: at, insert: ' '.repeat(delta) });
      return;
    }
    const lead = /^[ \t]*/.exec(this.state.doc.sliceString(at, line.to))![0];
    let removed = 0;
    let end = 0;
    while (end < lead.length && removed < -delta) {
      removed += lead[end] === '\t' ? 4 - (removed % 4) : 1;
      end++;
    }
    if (end) changes.push({ from: at, to: at + end, insert: ' '.repeat(Math.max(0, removed + delta)) });
  }
}

/**
 * Tab nests the list items on the selected lines under the item before
 * them (at that item's text column, which is what Markdown needs for `1.`
 * lists); Shift+Tab moves them out to their parent's level. Children move
 * along, and numbered lists that changed are renumbered.
 */
function shiftListItems(direction: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    const blocks = new Map<number, { block: ListBlock; entries: Entry[] }>();
    let inList = false;

    for (const range of state.selection.ranges) {
      for (let pos = range.from; pos <= range.to; ) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        const item = itemForLine(state, line);
        if (!item) continue;
        inList = true;
        const block = ListBlock.around(state, item);
        if (!blocks.has(block.key)) blocks.set(block.key, { block, entries: [] });
        const target = blocks.get(block.key)!;
        const entry = target.block.entry(item);
        if (entry && !target.entries.includes(entry)) target.entries.push(entry);
      }
    }
    if (!inList) return false;

    const changes: ChangeSpec[] = [];
    for (const { block, entries } of blocks.values()) {
      // An item whose parent is also selected moves with it.
      const top = entries.filter((entry) => !entries.some((other) => block.contains(other, entry)));
      top.sort((a, b) => a.line.number - b.line.number);
      let changed = false;
      for (const entry of top) changed = (direction > 0 ? block.indent(entry) : block.outdent(entry)) || changed;
      if (changed) changes.push(...block.changes());
    }
    if (changes.length) {
      view.dispatch({ changes, scrollIntoView: true, userEvent: direction > 0 ? 'input.indent' : 'delete.dedent' });
    }
    return true;
  };
}

export const indentListItem = shiftListItems(1);
export const outdentListItem = shiftListItems(-1);

const EMPTY_ITEM = /^((?:[ \t]*>[ \t]?)*)[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/;
const BLANK = /^[\s>]*$/;

/**
 * Enter on an empty list item leaves the list, like Bear, Typora or Notion:
 * a nested item moves up one level into its parent's list, a top-level item
 * becomes an empty paragraph. That paragraph is set off by blank lines,
 * since text typed right under a list item would continue the item.
 */
export const exitEmptyListItem: Command = (view) => {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || !main.empty) return false;
  const doc = state.doc;
  const line = doc.lineAt(main.head);
  const match = main.head === line.to ? EMPTY_ITEM.exec(line.text) : null;
  const item = match ? itemOnLine(state, line.from, line.to) : null;
  if (!match || !item) return false;
  const block = ListBlock.around(state, item);
  const entry = block.entry(item);
  if (!entry) return false;

  if (entry.parent) {
    block.outdent(entry);
    view.dispatch({ changes: block.changes(), scrollIntoView: true, userEvent: 'delete.dedent' });
    return true;
  }

  block.remove(entry, true);
  const quote = match[1];
  const blank = quote.trimEnd();
  const before = line.number > 1 && !BLANK.test(doc.line(line.number - 1).text) ? blank + state.lineBreak : '';
  const after = line.number < doc.lines && !BLANK.test(doc.line(line.number + 1).text) ? state.lineBreak + blank : '';
  view.dispatch({
    changes: [{ from: line.from, to: line.to, insert: before + quote + after }, ...block.changes()],
    selection: EditorSelection.cursor(line.from + before.length + quote.length),
    scrollIntoView: true,
    userEvent: 'delete',
  });
  return true;
};

/**
 * Backspace on an empty item removes the whole item, indentation included,
 * so a stray item goes away with two presses (the item, then the line
 * break), as in Notion or Google Docs. Numbers after it close up.
 */
export const deleteEmptyListItem: Command = (view) => {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  const match = main.head === line.to ? EMPTY_ITEM.exec(line.text) : null;
  const item = match ? itemOnLine(state, line.from, line.to) : null;
  if (!match || !item) return false;
  const block = ListBlock.around(state, item);
  const entry = block.entry(item);
  if (!entry || entry.children.length) return false;
  block.remove(entry, false);
  view.dispatch({
    changes: [{ from: line.from + match[1].length, to: line.to }, ...block.changes()],
    scrollIntoView: true,
    userEvent: 'delete',
  });
  return true;
};

/**
 * Shift+Enter breaks the line inside a list item and lines the new line up
 * with the item's text, so it stays part of the item, as in Typora,
 * Obsidian or Notion.
 */
export const breakListItem: Command = (view) => {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1) return false;
  let item: SyntaxNode | null = syntaxTree(state).resolveInner(main.from, -1);
  while (item && item.name !== 'ListItem') item = VERBATIM.has(item.name) ? null : item.parent;
  const mark = item?.getChild('ListMark');
  if (!item || !mark || main.from < mark.to) return false;
  const block = ListBlock.around(state, item);
  const entry = block.entry(item, true);
  if (!entry) return false;
  const line = state.doc.lineAt(main.from);
  const insert = `${state.lineBreak}${line.text.slice(0, block.prefix(line))}${' '.repeat(textColumn(entry, entry.col, entry.marker))}`;
  let from = main.from;
  while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--;
  view.dispatch({
    changes: { from, to: main.to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
};

/**
 * Enter on a continued line of an item's text (one made with Shift+Enter)
 * starts the next item, as in Typora or Obsidian, instead of adding yet
 * another line to the same item. Lines that only lazily continue an item
 * keep the plain Enter.
 */
export const continueListItem: Command = (view) => {
  const { state } = view;
  const { main } = state.selection;
  const doc = state.doc;
  const line = doc.lineAt(main.from);
  if (state.selection.ranges.length !== 1 || doc.lineAt(main.to).number !== line.number) return false;
  if (!line.text.trim() || itemOnLine(state, line.from, line.to)) return false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + /^[\s>]*/.exec(line.text)![0].length, 1);
  // A task's text is a Task node rather than a Paragraph.
  while (node && node.name !== 'Paragraph' && node.name !== 'Task') {
    node = VERBATIM.has(node.name) || node.name === 'ListItem' ? null : node.parent;
  }
  const item = node?.parent;
  if (!item || item.name !== 'ListItem') return false;
  const block = ListBlock.around(state, item);
  const entry = block.entry(item, true);
  if (!entry) return false;
  const prefix = block.prefix(line);
  const indent = countColumn(/^[ \t]*/.exec(line.text.slice(prefix))![0], 4);
  if (indent < textColumn(entry, entry.col, entry.marker)) return false;

  const ordered = isOrdered(entry.kind);
  const task = item.getChild('Task') ? ' [ ]' : '';
  const marker = ordered ? `${(entry.number ?? 0) + 1}${entry.kind}` : entry.kind;
  const insert = `${state.lineBreak}${line.text.slice(0, prefix)}${' '.repeat(entry.col)}${marker}${task} `;
  let from = main.from;
  while (from > line.from && /[ \t]/.test(doc.sliceString(from - 1, from))) from--;
  let to = main.to;
  while (to < line.to && /[ \t]/.test(doc.sliceString(to, to + 1))) to++;
  const changes: ChangeSpec[] = [{ from, to, insert }];
  // Numbers after the new item count up, as long as they were in sequence.
  if (ordered) {
    let expected = (entry.number ?? 0) + 1;
    for (let next = item.nextSibling; next; next = next.nextSibling) {
      const mark = next.name === 'ListItem' ? next.getChild('ListMark') : null;
      if (!mark) continue;
      if (Number(ORDERED.exec(doc.sliceString(mark.from, mark.to))?.[1]) !== expected) break;
      changes.push({ from: mark.from, to: mark.to, insert: `${++expected}${entry.kind}` });
    }
  }
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
};

/** An empty item's marker followed by another marker, as typed over it. */
const TYPED_MARKER = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+]|\d+[.)])([ \t]+\[[ xX]\])?[ \t]+([-*+]|\d{1,9}[.)])$/;

/**
 * Typing `- ` or `1. ` at the start of an empty list item switches the
 * item's kind instead of nesting a second list on the same line, so
 * `1. ` followed by `- ` becomes a bullet. The switch is its own undo step:
 * undo once to keep the typed text as it was.
 */
export function switchListMarker(view: EditorView, from: number, to: number, text: string): boolean {
  if (text !== ' ' || from !== to || view.state.selection.ranges.length !== 1) return false;
  const line = view.state.doc.lineAt(from);
  if (line.text.slice(from - line.from).trim()) return false;
  if (typedCheckbox(view, line, from)) return true;
  const match = TYPED_MARKER.exec(line.text.slice(0, from - line.from));
  const outer = match ? itemOnLine(view.state, line.from, line.to)?.getChild('ListMark') : null;
  if (!match || !outer || outer.from !== line.from + match[1].length) return false;
  const typed = match[4];
  // `- - ` on a plain bullet would change nothing, so the text stays as typed.
  if (kindOf(typed) === kindOf(match[2]) && !match[3]) return false;

  view.dispatch({ changes: { from, insert: ' ' }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
  const { state } = view;
  const item = itemOnLine(state, line.from, line.from + line.length + 1);
  const block = item ? ListBlock.around(state, item) : null;
  const entry = item && block?.entry(item);
  if (!block || !entry) return true;
  entry.typed = typed;
  entry.kind = kindOf(typed);
  // The typed marker parses as a list nested on the same line; it goes away.
  entry.children = entry.children.filter((child) => !child.inline);
  view.dispatch({
    changes: [{ from: entry.mark.to, to: from }, ...block.changes()],
    scrollIntoView: true,
    userEvent: 'input.format',
  });
  return true;
}

/** `[]` typed on an empty item or an empty line, as in Notion. */
const TYPED_CHECKBOX = /^((?:[ \t]*>[ \t]?)*[ \t]*)((?:[-*+]|\d+[.)])[ \t]+)?\[\]$/;

/** Typing `[] ` on an empty item, or on an empty line, makes it a task. */
function typedCheckbox(view: EditorView, line: Line, from: number): boolean {
  const { state } = view;
  const match = TYPED_CHECKBOX.exec(line.text.slice(0, from - line.from));
  if (!match) return false;
  const markerAt = line.from + match[1].length;
  if (match[2]) {
    if (itemOnLine(state, line.from, line.to)?.getChild('ListMark')?.from !== markerAt) return false;
  } else {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(markerAt, 1); node; node = node.parent) {
      if (VERBATIM.has(node.name) || node.name === 'ListItem') return false;
    }
  }
  const box = from - 2;
  view.dispatch({ changes: { from, insert: ' ' }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
  view.dispatch({
    changes: { from: box, to: from, insert: match[2] ? '[ ]' : '- [ ]' },
    scrollIntoView: true,
    userEvent: 'input.format',
  });
  return true;
}

export const listMarkerInput = EditorView.inputHandler.of(switchListMarker);
