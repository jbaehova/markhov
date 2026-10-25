import { type EditorView, WidgetType } from '@codemirror/view';
import type { Resources } from '../src/protocol';

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mh-hr';
    return span;
  }
}

export class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mh-codelang';
    span.textContent = this.lang;
    return span;
  }
}

/** Toggles the `[ ]` task marker that starts at `pos`. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const marker = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input.toggle',
  });
  return true;
}

/**
 * The marker of a list item (`-`, `1.`, `- [ ]` plus the following space),
 * drawn in a fixed-width gutter so item text always starts at the same place.
 */
export class ListMarkerWidget extends WidgetType {
  constructor(
    readonly kind: 'bullet' | 'ordered' | 'task',
    /** The number for ordered items, `x` or a space for tasks. */
    readonly text: string,
    /** Bullet shape level: disc, ring, square, then repeat. */
    readonly level: number,
    /** Offset of `[ ]` from the start of the marker, for tasks. */
    readonly taskOffset: number,
  ) {
    super();
  }

  eq(other: ListMarkerWidget): boolean {
    return (
      other.kind === this.kind &&
      other.text === this.text &&
      other.level === this.level &&
      other.taskOffset === this.taskOffset
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const gutter = document.createElement('span');
    gutter.className = `mh-li-marker mh-li-${this.kind}`;
    const inner = document.createElement('span');
    gutter.append(inner);

    if (this.kind === 'bullet') {
      inner.className = `mh-bullet mh-bullet-${this.level % 3}`;
      inner.setAttribute('aria-hidden', 'true');
    } else if (this.kind === 'ordered') {
      inner.className = 'mh-olmark';
      inner.textContent = this.text;
    } else {
      const checked = this.text !== ' ';
      inner.className = checked ? 'mh-checkbox mh-checked' : 'mh-checkbox';
      inner.setAttribute('role', 'checkbox');
      inner.setAttribute('aria-checked', String(checked));
      inner.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        toggleTaskAt(view, view.posAtDOM(gutter) + this.taskOffset);
      });
    }
    return gutter;
  }

  ignoreEvent(event: Event): boolean {
    // Checkbox clicks are handled above; other clicks place the cursor normally.
    return this.kind === 'task' && event.type === 'mousedown';
  }
}

/** Natural image sizes, so a re-created widget reserves its space before the image loads. */
const imageSizes = new Map<string, { width: number; height: number }>();

export function imageCandidates(src: string, resources: Resources): string[] {
  let path = src.trim();
  if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1);
  if (!path) return [];
  if (/^(?:https?:|data:|blob:)/i.test(path)) return [path];
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return [];

  const resolve = (relative: string, base: string | null) => {
    if (!base) return null;
    try {
      return new URL(relative, base).href;
    } catch {
      return null;
    }
  };
  const candidates = path.startsWith('/')
    ? // Root-relative paths usually mean the workspace root; fall back to an absolute file path.
      [resolve(path.slice(1), resources.workspaceUri), resolve(path, resources.baseUri)]
    : [resolve(path, resources.baseUri)];
  return [...new Set(candidates.filter((c): c is string => !!c))];
}

export class ImageWidget extends WidgetType {
  private readonly candidates: string[];

  constructor(
    readonly src: string,
    readonly alt: string,
    resources: Resources,
  ) {
    super();
    this.candidates = imageCandidates(src, resources);
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  get estimatedHeight(): number {
    return imageSizes.get(this.candidates[0] ?? '')?.height ?? -1;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'mh-image';
    const broken = () => {
      wrap.className = 'mh-image mh-image-broken';
      wrap.textContent = this.alt || this.src;
      wrap.title = `Image not found: ${this.src}`;
      view.requestMeasure();
    };
    if (!this.candidates.length) {
      broken();
      return wrap;
    }

    const img = document.createElement('img');
    img.alt = this.alt;
    img.draggable = false;
    let index = 0;
    const load = () => {
      const url = this.candidates[index];
      const size = imageSizes.get(url);
      if (size) {
        img.width = size.width;
        img.height = size.height;
      }
      img.src = url;
    };
    img.addEventListener('load', () => {
      imageSizes.set(this.candidates[index], { width: img.naturalWidth, height: img.naturalHeight });
      view.requestMeasure();
    });
    img.addEventListener('error', () => {
      index++;
      if (index < this.candidates.length) load();
      else broken();
    });
    load();
    wrap.append(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
