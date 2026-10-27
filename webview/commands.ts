import { type ChangeSpec, EditorSelection } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';
import { indentListItem, outdentListItem } from './lists';

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

export const formattingKeymap: KeyBinding[] = [
  { key: 'Tab', run: indentListItem, shift: outdentListItem },
  { key: 'Mod-]', run: indentListItem },
  { key: 'Mod-[', run: outdentListItem },
  { key: 'Mod-b', run: toggleInline('**') },
  { key: 'Mod-i', run: toggleInline('*') },
  { key: 'Mod-e', run: toggleInline('`') },
  { key: 'Mod-Shift-x', run: toggleInline('~~') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Enter', run: toggleTask },
  { key: 'Mod-Alt-0', run: setHeading(0) },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-Alt-${level}`, run: setHeading(level) })),
];
