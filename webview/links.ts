import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { post } from './host';
import { slugify } from './slug';

export { slugify };

function scrollToAnchor(view: EditorView, anchor: string): void {
  let target = anchor;
  try {
    target = decodeURIComponent(anchor);
  } catch {
    // Use the anchor as written.
  }
  const slug = slugify(target);
  let found: number | null = null;
  syntaxTree(view.state).iterate({
    enter(node) {
      if (found !== null) return false;
      if (/^(?:ATX|Setext)Heading/.test(node.name)) {
        const line = view.state.doc.lineAt(node.from);
        const text = line.text.replace(/^\s*#{1,6}\s*/, '').replace(/\s+#+\s*$/, '');
        if (slugify(text) === slug) found = line.from;
        return false;
      }
    },
  });
  if (found === null) return;
  view.dispatch({ selection: { anchor: found }, effects: EditorView.scrollIntoView(found, { y: 'start', yMargin: 48 }) });
  view.focus();
}

/** Destination of a reference definition such as `[label]: https://...`; labels match case-insensitively. */
export function resolveReference(text: string, label: string): string | null {
  const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = new RegExp(`^ {0,3}\\[${escaped}\\]:[ \\t]*<?([^\\s>]+)`, 'im').exec(text);
  return match ? match[1] : null;
}

export function openHref(view: EditorView, href: string): void {
  if (href.startsWith('#')) scrollToAnchor(view, href.slice(1));
  else post({ type: 'openLink', href });
}

/** Cmd/Ctrl+click opens links, like in the VS Code text editor. */
export const linkHandling = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const target = (event.target as HTMLElement).closest('[data-href], [data-ref]');
    const ref = target?.getAttribute('data-ref');
    const href = ref ? resolveReference(view.state.doc.toString(), ref) : target?.getAttribute('data-href');
    if (!href) return false;
    event.preventDefault();
    openHref(view, href);
    return true;
  },
});

/** Adds `mh-mod` to the body while Cmd/Ctrl is held so links can show a pointer. */
export function trackModifier(): void {
  const update = (event: KeyboardEvent | MouseEvent) =>
    document.body.classList.toggle('mh-mod', event.metaKey || event.ctrlKey);
  window.addEventListener('keydown', update);
  window.addEventListener('keyup', update);
  window.addEventListener('mousemove', update);
  window.addEventListener('blur', () => document.body.classList.remove('mh-mod'));
}
