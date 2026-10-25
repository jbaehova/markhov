import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { renderInline } from './inline';
import { needsRebuild, touches } from './state';

export interface TableCell {
  text: string;
  /** Offset of the cell content from the start of the table source. */
  offset: number;
}

export type Align = 'left' | 'center' | 'right' | null;

export interface ParsedTable {
  header: TableCell[];
  aligns: Align[];
  rows: TableCell[][];
}

/** Splits one table row on unescaped pipes. Offsets are relative to the line. */
export function splitRow(line: string): TableCell[] {
  const cells: TableCell[] = [];
  let start = 0;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
  if (line[start] === '|') start++;

  const cell = (from: number, to: number): TableCell => {
    while (from < to && line[from] === ' ') from++;
    while (to > from && line[to - 1] === ' ') to--;
    return { text: line.slice(from, to).replace(/\\\|/g, '|'), offset: from };
  };

  let cellStart = start;
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
    } else if (line[i] === '|') {
      cells.push(cell(cellStart, i));
      cellStart = i + 1;
    }
  }
  if (line.slice(cellStart).trim() !== '') cells.push(cell(cellStart, line.length));
  return cells;
}

export function parseTable(source: string): ParsedTable {
  const lines = source.split('\n');
  const rows: TableCell[][] = [];
  let lineOffset = 0;
  for (const line of lines) {
    rows.push(splitRow(line).map((c) => ({ text: c.text, offset: c.offset + lineOffset })));
    lineOffset += line.length + 1;
  }
  const [header = [], delimiter = [], ...body] = rows;
  const aligns = delimiter.map(({ text }): Align => {
    const left = text.startsWith(':');
    const right = text.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const width = header.length;
  return {
    header,
    aligns: Array.from({ length: width }, (_, i) => aligns[i] ?? null),
    rows: body.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? { text: '', offset: -1 })),
  };
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const table = parseTable(this.source);
    const wrap = document.createElement('div');
    wrap.className = 'mh-table-wrap';
    const element = document.createElement('table');
    element.className = 'mh-table';

    const row = (cells: TableCell[], tag: 'th' | 'td') => {
      const tr = document.createElement('tr');
      cells.forEach((cell, i) => {
        const td = document.createElement(tag);
        td.innerHTML = renderInline(cell.text);
        if (table.aligns[i]) td.style.textAlign = table.aligns[i]!;
        if (cell.offset >= 0) td.dataset.offset = String(cell.offset);
        tr.append(td);
      });
      return tr;
    };

    const head = document.createElement('thead');
    head.append(row(table.header, 'th'));
    const body = document.createElement('tbody');
    for (const cells of table.rows) body.append(row(cells, 'td'));
    element.append(head, body);
    wrap.append(element);

    // Clicking a cell reveals the table source with the cursor in that cell.
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-offset]');
      const start = view.posAtDOM(wrap);
      const offset = cell ? Number(cell.dataset.offset) : 0;
      view.dispatch({ selection: { anchor: Math.min(start + offset, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    // Let modified clicks through so the link handler can open links in cells.
    return !(event instanceof MouseEvent && (event.metaKey || event.ctrlKey));
  }
}

const SKIP = new Set(['Paragraph', 'FencedCode', 'CodeBlock', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'HTMLBlock', 'Frontmatter']);

function buildTables(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Table') {
        if (!touches(state, node.from, node.to)) {
          const from = state.doc.lineAt(node.from).from;
          const to = state.doc.lineAt(node.to).to;
          const widget = new TableWidget(state.sliceDoc(from, to));
          ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
        }
        return false;
      }
      if (SKIP.has(node.name)) return false;
    },
  });
  return Decoration.set(ranges);
}

/** Block widgets have to come from a state field, not a view plugin. */
export const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    if (tr.isUserEvent('input.type.compose')) return value.map(tr.changes);
    if (tr.docChanged || tr.selection || needsRebuild(tr) || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTables(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
