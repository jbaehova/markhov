import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { lineTouches, needsRebuild, resourcesFacet, touches } from './state';
import { CodeLangWidget, HrWidget, ImageWidget, ListMarkerWidget } from './widgets';

const hidden = Decoration.replace({});

const INLINE_CLASS: Record<string, string> = {
  Emphasis: 'mh-em',
  StrongEmphasis: 'mh-strong',
  Strikethrough: 'mh-strike',
  InlineCode: 'mh-inline-code',
};

/** Block nodes that are decorated in one go; seen guards against visiting them once per visible range. */
const WHOLE_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'Table', 'Frontmatter', 'HTMLBlock']);

class Builder {
  private readonly ranges: Range<Decoration>[] = [];
  private readonly lines = new Map<number, Set<string>>();
  private readonly depths = new Map<number, number>();
  readonly seen = new Set<string>();

  constructor(readonly state: EditorState) {}

  slice(from: number, to: number): string {
    return this.state.sliceDoc(from, to);
  }

  lineClass(pos: number, className: string): void {
    const from = this.state.doc.lineAt(pos).from;
    let classes = this.lines.get(from);
    if (!classes) this.lines.set(from, (classes = new Set()));
    for (const c of className.split(' ')) classes.add(c);
  }

  /** List nesting depth of a line; the stylesheet turns it into indentation. */
  lineDepth(pos: number, depth: number): void {
    this.depths.set(this.state.doc.lineAt(pos).from, depth);
  }

  linesClass(from: number, to: number, className: string): void {
    const doc = this.state.doc;
    for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) {
      this.lineClass(doc.line(n).from, className);
    }
  }

  mark(from: number, to: number, className: string, attributes?: Record<string, string>): void {
    if (from < to) this.ranges.push(Decoration.mark({ class: className, attributes }).range(from, to));
  }

  /** Replacing decorations from a plugin must not cross line breaks. */
  private singleLine(from: number, to: number): boolean {
    return from < to && this.state.doc.lineAt(from).number === this.state.doc.lineAt(to).number;
  }

  hide(from: number, to: number): void {
    if (this.singleLine(from, to)) this.ranges.push(hidden.range(from, to));
  }

  replace(from: number, to: number, widget: WidgetType): void {
    if (this.singleLine(from, to)) this.ranges.push(Decoration.replace({ widget }).range(from, to));
  }

  widget(pos: number, widget: WidgetType, side = 1): void {
    this.ranges.push(Decoration.widget({ widget, side }).range(pos));
  }

  finish(): DecorationSet {
    for (const [from, classes] of this.lines) {
      const depth = this.depths.get(from);
      const attributes = depth === undefined ? undefined : { style: `--mh-depth:${depth}` };
      this.ranges.push(Decoration.line({ class: [...classes].join(' '), attributes }).range(from));
    }
    return Decoration.set(this.ranges, true);
  }
}

/** Length of `mark` plus one following space or tab, if present. */
function withSpace(b: Builder, to: number): number {
  const next = b.slice(to, to + 1);
  return next === ' ' || next === '\t' ? to + 1 : to;
}

function heading(b: Builder, node: SyntaxNode, level: number): void {
  b.lineClass(node.from, `mh-h mh-h${level}`);
  const active = lineTouches(b.state, node.from);
  const marks = node.getChildren('HeaderMark');
  marks.forEach((mark, index) => {
    if (index === 0 && mark.from === node.from) {
      // Leading marks hang in the left margin so the text never shifts.
      const end = withSpace(b, mark.to);
      if (active) b.mark(mark.from, end, 'mh-syntax mh-hmark', { style: `margin-left:-${end - mark.from}ch` });
      else b.hide(mark.from, end);
    } else {
      const start = b.slice(mark.from - 1, mark.from) === ' ' ? mark.from - 1 : mark.from;
      if (active) b.mark(mark.from, mark.to, 'mh-syntax');
      else b.hide(start, mark.to);
    }
  });
}

function setextHeading(b: Builder, node: SyntaxNode, level: number): void {
  const mark = node.getChild('HeaderMark');
  // `-` typed under a paragraph is a setext underline until more is typed
  // (`- item` becomes a list). Hold off while the cursor is on that line so
  // the paragraph above does not flash into a heading.
  if (mark && lineTouches(b.state, mark.from)) return;
  const doc = b.state.doc;
  const textEnd = mark ? doc.lineAt(mark.from).from - 1 : node.to;
  b.linesClass(node.from, Math.max(node.from, textEnd), `mh-h mh-h${level}`);
  if (!mark) return;
  if (touches(b.state, node.from, node.to)) {
    b.mark(mark.from, mark.to, 'mh-syntax');
  } else {
    b.hide(mark.from, mark.to);
    b.lineClass(mark.from, 'mh-collapsed');
  }
}

function inlineMark(b: Builder, node: SyntaxNode): void {
  const parent = node.parent;
  if (!parent || !(parent.name in INLINE_CLASS)) return;
  if (touches(b.state, parent.from, parent.to)) b.mark(node.from, node.to, 'mh-syntax');
  else b.hide(node.from, node.to);
}

function link(b: Builder, node: SyntaxNode): void {
  const marks = node.getChildren('LinkMark');
  const url = node.getChild('URL');
  const label = node.getChild('LinkLabel');
  // A bare `[text]` is not a link unless it has a destination or a reference label.
  if (marks.length < 2 || (!url && !label)) return;
  const [open, close] = marks;
  const href = url ? b.slice(url.from, url.to) : '';
  // `[text][ref]` is resolved against its definition when clicked.
  const ref = label ? b.slice(label.from + 1, label.to - 1) || b.slice(open.to, close.from) : '';
  b.mark(open.to, close.from, 'mh-link', href ? { 'data-href': href } : { 'data-ref': ref });
  if (touches(b.state, node.from, node.to)) {
    b.mark(open.from, open.to, 'mh-syntax');
    b.mark(close.from, node.to, 'mh-syntax mh-link-target');
  } else {
    b.hide(open.from, open.to);
    b.hide(close.from, node.to);
  }
}

function image(b: Builder, node: SyntaxNode): void {
  const url = node.getChild('URL');
  const marks = node.getChildren('LinkMark');
  if (!url || marks.length < 2) return;
  const widget = new ImageWidget(
    b.slice(url.from, url.to),
    b.slice(marks[0].to, marks[1].from),
    b.state.facet(resourcesFacet),
  );
  if (touches(b.state, node.from, node.to)) {
    b.mark(node.from, node.to, 'mh-syntax mh-image-source');
    b.widget(node.to, widget);
  } else {
    b.replace(node.from, node.to, widget);
  }
}

function autolink(b: Builder, node: SyntaxNode): void {
  const url = node.getChild('URL');
  if (!url) return;
  b.mark(url.from, url.to, 'mh-link', { 'data-href': b.slice(url.from, url.to) });
  const active = touches(b.state, node.from, node.to);
  for (const mark of node.getChildren('LinkMark')) {
    if (active) b.mark(mark.from, mark.to, 'mh-syntax');
    else b.hide(mark.from, mark.to);
  }
}

const LISTS = new Set(['BulletList', 'OrderedList']);

/** Nesting depth of a list item: 0 for a top-level item. */
function listDepth(item: SyntaxNode): number {
  let depth = -1;
  for (let parent = item.parent; parent; parent = parent.parent) if (LISTS.has(parent.name)) depth++;
  return Math.max(depth, 0);
}

/** Bullet shape for an item: only bullet lists count, so `1.` > `-` still starts with a disc. */
function bulletLevel(item: SyntaxNode): number {
  let level = -1;
  for (let parent = item.parent; parent; parent = parent.parent) if (parent.name === 'BulletList') level++;
  return Math.max(level, 0);
}

/** Columns of quote markup (`> `) at the start of a line, which the quote handler owns. */
function quotePrefix(text: string): number {
  return /^(?:[ \t]*>[ \t]?)*/.exec(text)![0].length;
}

/** Where the text of a list item starts, after its marker and one space. */
function itemContentStart(b: Builder, item: SyntaxNode): number | null {
  const mark = item.getChild('ListMark');
  if (!mark) return null;
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker');
  return withSpace(b, taskMarker ? taskMarker.to : mark.to);
}

/**
 * Lists get real indentation: the marker sits in a fixed-width gutter, the
 * source indentation is hidden and replaced by a per-depth indent, and
 * wrapped lines hang under the item text instead of under the marker.
 */
function listItem(b: Builder, item: SyntaxNode): void {
  const mark = item.getChild('ListMark');
  const list = item.parent;
  const contentStart = itemContentStart(b, item);
  if (!mark || !list || contentStart === null) return;
  const doc = b.state.doc;
  const line = doc.lineAt(mark.from);
  const depth = listDepth(item);
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker');
  const markerEnd = taskMarker ? taskMarker.to : mark.to;

  b.lineClass(line.from, 'mh-li');
  b.lineDepth(line.from, depth);
  b.hide(Math.max(line.from + quotePrefix(line.text), lineIndentStart(b, mark.from, line.from)), mark.from);

  const checked = !!taskMarker && /x/i.test(b.slice(taskMarker.from, taskMarker.to));
  if (checked) b.lineClass(line.from, 'mh-task-done');

  if (touches(b.state, mark.from, markerEnd)) {
    b.mark(mark.from, contentStart, 'mh-syntax mh-li-raw');
  } else if (taskMarker) {
    b.replace(mark.from, contentStart, new ListMarkerWidget('task', checked ? 'x' : ' ', 0, taskMarker.from - mark.from));
  } else if (list.name === 'OrderedList') {
    b.replace(mark.from, contentStart, new ListMarkerWidget('ordered', b.slice(mark.from, mark.to), 0, 0));
  } else {
    b.replace(mark.from, contentStart, new ListMarkerWidget('bullet', '', bulletLevel(item), 0));
  }

  // Lines that continue the item's paragraphs line up with its text.
  const column = contentStart - line.from;
  for (const paragraph of item.getChildren('Paragraph')) {
    const first = doc.lineAt(paragraph.from).number;
    const last = doc.lineAt(paragraph.to).number;
    for (let n = first; n <= last; n++) {
      const continued = doc.line(n);
      if (continued.number === line.number || !continued.text.trim()) continue;
      b.lineClass(continued.from, 'mh-li-cont');
      b.lineDepth(continued.from, depth);
      const prefix = quotePrefix(continued.text);
      const indent = /^[ \t]*/.exec(continued.text.slice(prefix))![0].length;
      b.hide(continued.from + prefix, continued.from + prefix + Math.min(indent, column));
    }
  }
}

/** Start of the run of spaces and tabs that ends at `pos`. */
function lineIndentStart(b: Builder, pos: number, lineFrom: number): number {
  let start = pos;
  while (start > lineFrom && /[ \t]/.test(b.slice(start - 1, start))) start--;
  return start;
}

function fencedCode(b: Builder, node: SyntaxNode): void {
  const doc = b.state.doc;
  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  const marks = node.getChildren('CodeMark');
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  const closed = !!closing && last.number > first.number && doc.lineAt(closing.from).number === last.number;
  const active = touches(b.state, node.from, node.to);

  for (let n = first.number; n <= last.number; n++) {
    const classes = ['mh-codeblock'];
    if (n === first.number) classes.push('mh-codeblock-first');
    if (n === last.number) classes.push('mh-codeblock-last');
    if (!active && (n === first.number || (closed && n === last.number))) classes.push('mh-fence-hidden');
    b.lineClass(doc.line(n).from, classes.join(' '));
  }

  let item = node.parent;
  while (item && item.name !== 'ListItem') item = item.parent;
  const contentStart = item ? itemContentStart(b, item) : null;
  if (item && contentStart !== null) {
    const column = contentStart - doc.lineAt(contentStart).from;
    const depth = listDepth(item);
    for (let n = first.number; n <= last.number; n++) {
      const line = doc.line(n);
      b.lineClass(line.from, 'mh-in-li');
      b.lineDepth(line.from, depth);
      const isHiddenFence = !active && (n === first.number || (closed && n === last.number));
      if (isHiddenFence) continue;
      const prefix = quotePrefix(line.text);
      const indent = /^[ \t]*/.exec(line.text.slice(prefix))![0].length;
      b.hide(line.from + prefix, line.from + prefix + Math.min(indent, column));
    }
  }

  const info = node.getChild('CodeInfo');
  if (active) {
    for (const mark of marks) b.mark(mark.from, mark.to, 'mh-syntax');
    if (info) b.mark(info.from, info.to, 'mh-syntax');
  } else {
    b.replace(first.from, first.to, new CodeLangWidget(info ? b.slice(info.from, info.to) : ''));
    if (closed) b.hide(last.from, last.to);
  }
}

function visit(b: Builder, ref: SyntaxNodeRef): boolean | void {
  const name = ref.name;
  if (WHOLE_BLOCKS.has(name)) {
    const key = `${name}:${ref.from}`;
    if (b.seen.has(key)) return false;
    b.seen.add(key);
  }
  const node = ref.node;
  const { state } = b;

  switch (name) {
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
      heading(b, node, Number(name.slice(-1)));
      return;
    case 'SetextHeading1':
    case 'SetextHeading2':
      setextHeading(b, node, Number(name.slice(-1)));
      return;
    case 'Emphasis':
    case 'StrongEmphasis':
    case 'Strikethrough':
    case 'InlineCode':
      b.mark(node.from, node.to, INLINE_CLASS[name]);
      return;
    case 'EmphasisMark':
    case 'StrikethroughMark':
    case 'CodeMark':
      inlineMark(b, node);
      return false;
    case 'Link':
      link(b, node);
      return;
    case 'Image':
      image(b, node);
      return false;
    case 'Autolink':
      autolink(b, node);
      return false;
    case 'URL': {
      const parent = node.parent?.name;
      if (parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference') {
        b.mark(node.from, node.to, 'mh-link', { 'data-href': b.slice(node.from, node.to) });
      }
      return false;
    }
    case 'LinkReference':
      b.mark(node.from, node.to, 'mh-linkref');
      return false;
    case 'Blockquote': {
      let depth = 0;
      for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) if (parent.name === 'Blockquote') depth++;
      b.linesClass(node.from, node.to, `mh-quote mh-quote-${Math.min(depth, 3)}`);
      return;
    }
    case 'QuoteMark': {
      const end = withSpace(b, node.to);
      if (lineTouches(state, node.from)) b.mark(node.from, end, 'mh-syntax');
      else b.hide(node.from, end);
      return false;
    }
    case 'ListItem': {
      // Children still need visiting for inline formatting, so dedupe here instead of via WHOLE_BLOCKS.
      const key = `ListItem:${node.from}`;
      if (!b.seen.has(key)) {
        b.seen.add(key);
        listItem(b, node);
      }
      return;
    }
    case 'ListMark':
    case 'TaskMarker':
      return false;
    case 'FencedCode':
      fencedCode(b, node);
      return false;
    case 'CodeBlock':
      b.linesClass(node.from, node.to, 'mh-codeblock mh-indented');
      return false;
    case 'HorizontalRule':
      if (lineTouches(state, node.from)) b.mark(node.from, node.to, 'mh-syntax');
      else b.replace(node.from, node.to, new HrWidget());
      return false;
    case 'Table':
      // Inactive tables are rendered as a block widget by the table field.
      if (touches(state, node.from, node.to)) b.linesClass(node.from, node.to, 'mh-table-raw');
      return false;
    case 'Frontmatter':
      b.linesClass(node.from, node.to, 'mh-frontmatter');
      return false;
    case 'HTMLBlock':
      b.linesClass(node.from, node.to, 'mh-html');
      return false;
    case 'HTMLTag':
    case 'Comment':
      b.mark(node.from, node.to, 'mh-html');
      return false;
    case 'Escape':
      if (!touches(state, node.from, node.to)) b.hide(node.from, node.from + 1);
      return false;
  }
}

function build(view: EditorView): DecorationSet {
  const b = new Builder(view.state);
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({ from, to, enter: (ref) => visit(b, ref) });
  }
  return b.finish();
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // Rebuilding while an IME composition is in progress can break Hangul input.
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.transactions.some(needsRebuild) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
