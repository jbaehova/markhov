import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { exitEmptyListItem, indentListItem, outdentListItem } from '../webview/commands';

/** Runs a command against a plain state with the cursor at the first `|`. */
function run(command: (view: EditorView) => boolean, source: string): { handled: boolean; text: string } {
  const cursor = source.indexOf('|');
  let state = EditorState.create({
    doc: source.replace('|', ''),
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState['update']>[0] | Transaction) {
      state = ('changes' in spec && 'startState' in spec ? spec : state.update(spec)).state;
    },
  } as unknown as EditorView;
  const handled = command(view);
  return { handled, text: state.doc.toString() };
}

describe('Tab in lists', () => {
  it('nests a bullet under the previous item, children included', () => {
    expect(run(indentListItem, '- one\n- t|wo\n  - child')).toEqual({ handled: true, text: '- one\n  - two\n    - child' });
  });

  it('nests an ordered item to the text column and renumbers it', () => {
    expect(run(indentListItem, '1. one\n2. two|')).toEqual({ handled: true, text: '1. one\n   1. two' });
  });

  it('continues numbering when the previous item already has a sublist', () => {
    expect(run(indentListItem, '1. one\n   1. a\n2. two|').text).toBe('1. one\n   1. a\n   2. two');
  });

  it('swallows Tab on a first item instead of indenting it into a code block', () => {
    expect(run(indentListItem, '- fi|rst')).toEqual({ handled: true, text: '- first' });
  });

  it('leaves non-list lines to the default Tab', () => {
    expect(run(indentListItem, 'para|graph').handled).toBe(false);
  });

  it('works inside block quotes', () => {
    expect(run(indentListItem, '> - one\n> - two|').text).toBe('> - one\n>   - two');
  });
});

describe('Shift+Tab in lists', () => {
  it('moves a nested item back to its parent level', () => {
    expect(run(outdentListItem, '- one\n  - two|\n    - child').text).toBe('- one\n- two\n  - child');
  });

  it('renumbers an ordered item after its parent', () => {
    expect(run(outdentListItem, '1. one\n   1. two|').text).toBe('1. one\n2. two');
  });
});

describe('Enter on an empty list item', () => {
  it('removes the marker of a top-level item', () => {
    expect(run(exitEmptyListItem, '- one\n- |')).toEqual({ handled: true, text: '- one\n' });
  });

  it('moves a nested empty item up a level', () => {
    expect(run(exitEmptyListItem, '- one\n  - |').text).toBe('- one\n- ');
  });

  it('keeps the quote marker', () => {
    expect(run(exitEmptyListItem, '> - one\n> - |').text).toBe('> - one\n> ');
  });

  it('leaves items with text to the default Enter', () => {
    expect(run(exitEmptyListItem, '- one|').handled).toBe(false);
  });
});
