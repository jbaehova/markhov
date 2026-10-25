import { syntaxTree } from '@codemirror/language';
import { type ChangeSpec, EditorSelection, type EditorState } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/** Wraps each selection in `mark`, or unwraps it when it is already wrapped. */
export function toggleInline(mark: string): Command {
  const size = mark.length;
  return (view) => {
    const { state } = view;
    const wrappedOutside = (from: number, to: number) => {
      if (state.sliceDoc(from - size, from) !== mark || state.sliceDoc(to, to + size) !== mark) return false;
      // `*` next to `**` belongs to the bold markers, not to an italic pair.
      if (size === 1) {
        return state.sliceDoc(from - 2, from - 1) !== mark && state.sliceDoc(to + 1, to + 2) !== mark;
      }
      return true;
    };
    const transaction = state.changeByRange((range) => {
      if (wrappedOutside(range.from, range.to)) {
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= size * 2 && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(size, -size) },
          range: EditorSelection.range(range.from, range.to - size * 2),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    });
    view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

function eachLine(view: EditorView, fn: (line: { from: number; text: string }) => ChangeSpec | null): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const change = fn(line);
        if (change) changes.push(change);
      }
      pos = line.to + 1;
    }
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
  return true;
}

/** Sets the heading level of the selected lines; the same level again turns it back into a paragraph. */
export function setHeading(level: number): Command {
  return (view) =>
    eachLine(view, (line) => {
      const match = /^(#{1,6})(?:[ \t]+|$)/.exec(line.text);
      const current = match ? match[1].length : 0;
      const insert = level === 0 || current === level ? '' : `${'#'.repeat(level)} `;
      return { from: line.from, to: line.from + (match ? match[0].length : 0), insert };
    });
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)/;

/** Checks or unchecks a task; turns other lines into tasks. */
export const toggleTask: Command = (view) =>
  eachLine(view, (line) => {
    const task = TASK.exec(line.text);
    if (task) {
      const at = line.from + task[1].length + 1;
      return { from: at, to: at + 1, insert: task[2] === ' ' ? 'x' : ' ' };
    }
    const item = LIST_ITEM.exec(line.text);
    if (item) return { from: line.from + item[1].length, insert: '[ ] ' };
    const indent = /^\s*/.exec(line.text)![0].length;
    return { from: line.from + indent, insert: '- [ ] ' };
  });

export const insertLink: Command = (view) => {
  const { state } = view;
  const transaction = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text ? EditorSelection.cursor(range.from + insert.length - 1) : EditorSelection.cursor(range.from + 1),
    };
  });
  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** The list item whose marker is on the given line. */
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

function quotePrefix(text: string): number {
  return /^(?:[ \t]*>[ \t]?)*/.exec(text)![0].length;
}

/** Column (from line start) where a list item's text begins. */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark')!;
  const line = state.doc.lineAt(mark.from);
  const task = item.getChild('Task')?.getChild('TaskMarker');
  const end = task ? task.to : mark.to;
  return end - line.from + (/[ \t]/.test(state.sliceDoc(end, end + 1)) ? 1 : 0);
}

const ORDERED = /^(\d+)([.)])$/;

function orderedNumber(state: EditorState, item: SyntaxNode): number | null {
  const mark = item.getChild('ListMark');
  const match = mark ? ORDERED.exec(state.sliceDoc(mark.from, mark.to)) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Tab nests a list item under the previous one (indenting it to that item's
 * text column, which is what Markdown needs for `1.` lists); Shift+Tab moves
 * it back out to its parent's level. Child lines move along with the item.
 */
function shiftListItems(direction: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    const doc = state.doc;
    const changes: ChangeSpec[] = [];
    const moved = new Set<number>();
    let inList = false;

    for (const range of state.selection.ranges) {
      for (let pos = range.from; pos <= range.to; ) {
        const line = doc.lineAt(pos);
        pos = line.to + 1;
        if (moved.has(line.number)) continue;
        const item = itemOnLine(state, line.from, line.to);
        if (!item) continue;
        inList = true;
        const mark = item.getChild('ListMark')!;
        const current = mark.from - line.from;

        let target: number;
        let number: number | null = null;
        if (direction > 0) {
          // Quote marks of continued lines sit between items, so skip over them.
          let previous = item.prevSibling;
          while (previous && previous.name !== 'ListItem') previous = previous.prevSibling;
          if (!previous) continue;
          target = contentColumn(state, previous);
          const sublists = [...previous.getChildren('BulletList'), ...previous.getChildren('OrderedList')];
          const nested = sublists.length ? sublists[sublists.length - 1].getChildren('ListItem') : [];
          const lastNested = nested[nested.length - 1];
          number = lastNested ? (orderedNumber(state, lastNested) ?? 0) + 1 : 1;
        } else {
          const parent = item.parent?.parent;
          if (!parent || parent.name !== 'ListItem') continue;
          const parentMark = parent.getChild('ListMark')!;
          target = parentMark.from - doc.lineAt(parentMark.from).from;
          number = (orderedNumber(state, parent) ?? 0) + 1;
        }
        const delta = target - current;
        if (!delta) continue;

        const last = doc.lineAt(item.to).number;
        for (let n = line.number; n <= last; n++) {
          const l = doc.line(n);
          moved.add(n);
          if (!l.text.trim()) continue;
          const at = l.from + quotePrefix(l.text);
          if (delta > 0) {
            changes.push({ from: at, insert: ' '.repeat(delta) });
          } else {
            const spaces = /^ */.exec(doc.sliceString(at, l.to))![0].length;
            if (spaces) changes.push({ from: at, to: at + Math.min(spaces, -delta) });
          }
        }
        const ordered = ORDERED.exec(state.sliceDoc(mark.from, mark.to));
        if (ordered && number) changes.push({ from: mark.from, to: mark.to, insert: `${number}${ordered[2]}` });
      }
    }
    if (!inList) return false;
    if (changes.length) {
      view.dispatch({ changes, scrollIntoView: true, userEvent: direction > 0 ? 'input.indent' : 'delete.dedent' });
    }
    return true;
  };
}

export const indentListItem = shiftListItems(1);
export const outdentListItem = shiftListItems(-1);

const EMPTY_ITEM = /^((?:[ \t]*>[ \t]?)*)[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/;

/**
 * Enter on an empty list item leaves the list, like Bear, Typora or Notion:
 * a nested item moves up one level, a top-level item loses its marker.
 */
export const exitEmptyListItem: Command = (view) => {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  const match = main.head === line.to ? EMPTY_ITEM.exec(line.text) : null;
  const item = match ? itemOnLine(state, line.from, line.to) : null;
  if (!match || !item) return false;
  if (item.parent?.parent?.name === 'ListItem') return outdentListItem(view);
  view.dispatch({ changes: { from: line.from + match[1].length, to: line.to }, userEvent: 'delete' });
  return true;
};

export const formattingKeymap: KeyBinding[] = [
  { key: 'Tab', run: indentListItem, shift: outdentListItem },
  { key: 'Mod-b', run: toggleInline('**') },
  { key: 'Mod-i', run: toggleInline('*') },
  { key: 'Mod-e', run: toggleInline('`') },
  { key: 'Mod-Shift-x', run: toggleInline('~~') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Enter', run: toggleTask },
  { key: 'Mod-Alt-0', run: setHeading(0) },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-Alt-${level}`, run: setHeading(level) })),
];
