import './theme.css';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, type Extension, Prec } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view';
import type { MarkhovConfig, Resources } from '../src/protocol';
import { exitEmptyListItem, formattingKeymap } from './commands';
import { Frontmatter } from './frontmatter';
import { codeHighlight } from './highlight';
import { onHostMessage, post } from './host';
import { linkHandling, trackModifier } from './links';
import { livePreview } from './livePreview';
import { focusTracking, refresh, resourcesFacet } from './state';
import { SyncClient } from './sync';
import { tableField } from './tables';

const root = document.getElementById('root')!;
const sync = new SyncClient();
let view: EditorView | null = null;
let resources: Resources = { baseUri: null, workspaceUri: null };

const compositionRefresh = EditorView.domEventHandlers({
  compositionend(_event, view) {
    setTimeout(() => view.dispatch({ effects: refresh.of(null) }));
    return false;
  },
});

function extensions(version: number): Extension[] {
  return [
    sync.extension(version),
    resourcesFacet.of(resources),
    focusTracking,
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Frontmatter] }),
    syntaxHighlighting(codeHighlight),
    livePreview,
    tableField,
    linkHandling,
    compositionRefresh,
    search({ top: true }),
    // Ahead of the markdown keymap's Enter, which only loosens the list.
    Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyListItem }])),
    keymap.of([...formattingKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  ];
}

function createState(text: string, version: number, selection?: EditorSelection): EditorState {
  const clamped = selection?.ranges.every((r) => r.to <= text.length) ? selection : undefined;
  return EditorState.create({ doc: text, selection: clamped, extensions: extensions(version) });
}

function applyConfig(config: MarkhovConfig): void {
  const style = document.documentElement.style;
  style.setProperty('--mh-size', `${config.fontSize}px`);
  style.setProperty('--mh-line', String(config.lineHeight));
  style.setProperty('--mh-width', `${config.maxWidth}px`);
  if (config.fontFamily.trim()) style.setProperty('--mh-font', config.fontFamily);
  else style.removeProperty('--mh-font');
  document.body.dataset.colors = config.colors;
  document.body.dataset.appearance = config.appearance;
  view?.requestMeasure();
}

onHostMessage((message) => {
  switch (message.type) {
    case 'init':
      applyConfig(message.config);
      resources = message.resources;
      view?.destroy();
      view = new EditorView({ state: createState(message.text, message.version), parent: root });
      sync.view = view;
      // Exposed for the browser test harness.
      (window as { markhovView?: EditorView }).markhovView = view;
      if (document.hasFocus()) view.focus();
      break;
    case 'updates':
      sync.receive(message.fromVersion, message.updates);
      break;
    case 'pushResult':
      sync.pushResult(message.ok);
      break;
    case 'reset':
      if (view) {
        sync.reset();
        view.setState(createState(message.text, message.version, view.state.selection));
      }
      break;
    case 'config':
      applyConfig(message.config);
      break;
  }
});

// Keys the editor handled must not also reach VS Code (Cmd+B would toggle
// the sidebar, Cmd+Z would run a second undo). VS Code listens on window,
// so stopping the event at the document is enough. Unhandled keys such as
// Cmd+S or Cmd+Shift+M still reach VS Code keybindings.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) event.stopPropagation();
});

// The webview gets focus when its tab is activated; hand it to the editor.
window.addEventListener('focus', () => {
  if (view && !view.hasFocus) view.focus();
});

// Surface webview failures (CSP violations, chunk loading) in the Markhov output channel.
window.addEventListener('error', (event) => post({ type: 'error', message: event.message }));
window.addEventListener('unhandledrejection', (event) => post({ type: 'error', message: String(event.reason) }));
document.addEventListener('securitypolicyviolation', (event) =>
  post({ type: 'error', message: `CSP blocked ${event.blockedURI} (${event.violatedDirective})` }),
);

trackModifier();
post({ type: 'ready' });
