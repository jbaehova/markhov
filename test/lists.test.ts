import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  breakListItem,
  continueListItem,
  deleteEmptyListItem,
  EmptyListItems,
  exitEmptyListItem,
  indentListItem,
  outdentListItem,
  switchListMarker,
} from '../webview/lists';

/**
 * Runs a command against a plain state. The cursor is at `|`, or the
 * selection spans `«` to `»`; the result marks the cursor the same way.
 */
function run(command: (view: EditorView) => boolean, source: string): { handled: boolean; text: string } {
  let selection: EditorSelection;
  let doc: string;
  if (source.includes('«')) {
    const from = source.indexOf('«');
    doc = source.replace('«', '');
    const to = doc.indexOf('»');
    doc = doc.replace('»', '');
    selection = EditorSelection.single(from, to);
  } else {
    selection = EditorSelection.single(source.indexOf('|'));
    doc = source.replace('|', '');
  }
  let state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage, extensions: [EmptyListItems] })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState['update']>[0] | Transaction) {
      state = ('changes' in spec && 'startState' in spec ? spec : state.update(spec)).state;
      ensureSyntaxTree(state, state.doc.length, 5000);
    },
  } as unknown as EditorView;
  const handled = command(view);
  const { main } = state.selection;
  const text = state.doc.toString();
  return { handled, text: main.empty ? text.slice(0, main.head) + '|' + text.slice(main.head) : text };
}

/** Names of the block nodes a document parses into, outermost first. */
function blocks(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [EmptyListItems] })] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const names: string[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (/^(?:BulletList|OrderedList|ListItem|Paragraph|SetextHeading\d)$/.test(node.name)) names.push(node.name);
    },
  });
  return names;
}

/** Types a space at the cursor, the way the editor's input handler sees it. */
const typeSpace = (view: EditorView) => {
  const at = view.state.selection.main.head;
  return switchListMarker(view, at, at, ' ');
};

describe('Tab in lists', () => {
  it('nests a bullet under the previous item, children included', () => {
    expect(run(indentListItem, '- one\n- t|wo\n  - child').text).toBe('- one\n  - t|wo\n    - child');
  });

  it('nests an ordered item to the text column and renumbers it', () => {
    expect(run(indentListItem, '1. one\n2. two|').text).toBe('1. one\n   1. two|');
  });

  it('renumbers the items after it', () => {
    expect(run(indentListItem, '1. one\n2. two|\n3. three').text).toBe('1. one\n   1. two|\n2. three');
  });

  it('continues numbering when the previous item already has a sublist', () => {
    expect(run(indentListItem, '1. one\n   1. a\n2. two|').text).toBe('1. one\n   1. a\n   2. two|');
  });

  it('joins the bullets of an existing sublist', () => {
    expect(run(indentListItem, '1. one\n   - a\n2. two|').text).toBe('1. one\n   - a\n   - two|');
  });

  it('nests under a task at the bullet text column, not after the checkbox', () => {
    expect(run(indentListItem, '- [ ] one\n- [ ] two|').text).toBe('- [ ] one\n  - [ ] two|');
  });

  it('indents every selected item one level and numbers them in order', () => {
    expect(run(indentListItem, '1. one\n2. «two\n3. three»').text).toBe('1. one\n   1. two\n   2. three');
  });

  it('nests an item under one from the list right before it', () => {
    expect(run(indentListItem, '- one\n1. two|').text).toBe('- one\n  1. two|');
  });

  it('moves an item from a continued line of its text', () => {
    expect(run(indentListItem, '- one\n- two\n  mo|re').text).toBe('- one\n  - two\n    mo|re');
  });

  it('shifts code inside the item along with it', () => {
    expect(run(indentListItem, '1. one\n2. two|\n   ```\n   x\n   ```').text).toBe(
      '1. one\n   1. two|\n      ```\n      x\n      ```',
    );
  });

  it('keeps Tab for code blocks inside items', () => {
    expect(run(indentListItem, '- one\n  ```\n  co|de\n  ```').handled).toBe(false);
  });

  it('swallows Tab on a first item instead of indenting it into a code block', () => {
    expect(run(indentListItem, '- fi|rst')).toEqual({ handled: true, text: '- fi|rst' });
  });

  it('leaves non-list lines to the default Tab', () => {
    expect(run(indentListItem, 'para|graph').handled).toBe(false);
  });

  it('works inside block quotes', () => {
    expect(run(indentListItem, '> - one\n> - two|').text).toBe('> - one\n>   - two|');
  });
});

describe('Shift+Tab in lists', () => {
  it('moves a nested item back to its parent level', () => {
    expect(run(outdentListItem, '- one\n  - two|\n    - child').text).toBe('- one\n- two|\n  - child');
  });

  it('renumbers an ordered item after its parent and the items after that', () => {
    expect(run(outdentListItem, '1. one\n   1. two|\n2. three').text).toBe('1. one\n2. two|\n3. three');
  });

  it('takes the kind of the list it moves into', () => {
    expect(run(outdentListItem, '1. one\n   - two|\n2. three').text).toBe('1. one\n2. two|\n3. three');
  });

  it('keeps the following items nested, now under the moved item', () => {
    expect(run(outdentListItem, '1. one\n   1. two|\n   2. three').text).toBe('1. one\n2. two|\n   1. three');
  });

  it('realigns children when the marker gets wider', () => {
    expect(run(outdentListItem, '9. nine\n   1. ten|\n      - child').text).toBe('9. nine\n10. ten|\n    - child');
  });

  it('swallows Shift+Tab on a top-level item', () => {
    expect(run(outdentListItem, '- on|e')).toEqual({ handled: true, text: '- on|e' });
  });
});

describe('Enter on an empty list item', () => {
  it('ends the list with a blank line so new text does not continue the item', () => {
    expect(run(exitEmptyListItem, '- one\n- |')).toEqual({ handled: true, text: '- one\n\n|' });
  });

  it('turns an empty item in the middle into a paragraph and restarts the numbers after it', () => {
    expect(run(exitEmptyListItem, '1. one\n2. |\n3. three').text).toBe('1. one\n\n|\n\n1. three');
  });

  it('needs no extra blank line in a loose list', () => {
    expect(run(exitEmptyListItem, '- one\n\n- |').text).toBe('- one\n\n|');
  });

  it('moves a nested empty item up into the parent list', () => {
    expect(run(exitEmptyListItem, '- one\n  - |').text).toBe('- one\n- |');
    expect(run(exitEmptyListItem, '1. one\n   - |').text).toBe('1. one\n2. |');
  });

  it('keeps the quote marker', () => {
    expect(run(exitEmptyListItem, '> - one\n> - |').text).toBe('> - one\n>\n> |');
  });

  it('leaves items with text to the default Enter', () => {
    expect(run(exitEmptyListItem, '- one|').handled).toBe(false);
  });
});

describe('Typing a marker on an empty item', () => {
  it('turns a numbered item into a bullet', () => {
    expect(run(typeSpace, '1. one\n   1. -|').text).toBe('1. one\n   - |');
  });

  it('turns a bullet into a numbered item that continues the list', () => {
    expect(run(typeSpace, '1. one\n- 1.|').text).toBe('1. one\n2. |');
  });

  it('starts a numbered list from the typed number', () => {
    expect(run(typeSpace, '- one\n- 3.|').text).toBe('- one\n3. |');
  });

  it('drops the checkbox of a task', () => {
    expect(run(typeSpace, '- [ ] 1.|').text).toBe('1. |');
  });

  it('realigns the children of the item', () => {
    expect(run(typeSpace, '1. -|\n   - child').text).toBe('- |\n  - child');
  });

  it('leaves text that is not an empty item alone', () => {
    expect(run(typeSpace, '1. one -|').handled).toBe(false);
    expect(run(typeSpace, '- -|').handled).toBe(false);
  });
});

describe('Backspace on an empty list item', () => {
  it('removes a nested item with its indentation in one press', () => {
    expect(run(deleteEmptyListItem, '1. one\n   - |')).toEqual({ handled: true, text: '1. one\n|' });
  });

  it('closes up the numbers after it', () => {
    expect(run(deleteEmptyListItem, '1. one\n2. |\n3. three').text).toBe('1. one\n|\n2. three');
  });

  it('keeps the quote marker', () => {
    expect(run(deleteEmptyListItem, '> - one\n> - |').text).toBe('> - one\n> |');
  });

  it('moves the children of a removed item out into its place', () => {
    expect(run(deleteEmptyListItem, '### Heading\n- |\n    - child').text).toBe('### Heading\n|\n- child');
    expect(run(deleteEmptyListItem, '- a\n  - |\n    - b\n      - c').text).toBe('- a\n|\n  - b\n    - c');
  });

  it('leaves items with text to the default Backspace', () => {
    expect(run(deleteEmptyListItem, '- one|').handled).toBe(false);
    expect(run(deleteEmptyListItem, '- |one').handled).toBe(false);
  });
});

describe('Enter on a continued line of an item', () => {
  it('starts the next item', () => {
    expect(run(continueListItem, '- one\n  more|').text).toBe('- one\n  more\n- |');
  });

  it('numbers the new item and the ones after it', () => {
    expect(run(continueListItem, '1. one\n   more|\n2. two').text).toBe('1. one\n   more\n2. |\n3. two');
  });

  it('starts an unchecked task after a task', () => {
    expect(run(continueListItem, '- [x] one\n  more|').text).toBe('- [x] one\n  more\n- [ ] |');
  });

  it('moves the text after the cursor into the new item', () => {
    expect(run(continueListItem, '  - one\n    mo|re').text).toBe('  - one\n    mo\n  - |re');
  });

  it('leaves lazy continuation lines and code to the default Enter', () => {
    expect(run(continueListItem, '- one\nlazy|').handled).toBe(false);
    expect(run(continueListItem, '- one\n  ```\n  code|\n  ```').handled).toBe(false);
  });
});

describe('Enter in an item', () => {
  it('starts the next item right below, even in a loose list', () => {
    expect(run(continueListItem, '- one\n\n- two|').text).toBe('- one\n\n- two\n- |');
    expect(run(continueListItem, '- one\n  - sub\n  \n- two|\n- three').text).toBe('- one\n  - sub\n  \n- two\n- |\n- three');
  });

  it('moves the text after the cursor into the new item', () => {
    expect(run(continueListItem, '- tw|o').text).toBe('- tw\n- |o');
  });

  it('numbers the new item and continues tasks', () => {
    expect(run(continueListItem, '1. one|\n\n2. two').text).toBe('1. one\n2. |\n\n3. two');
    expect(run(continueListItem, '- [x] done|').text).toBe('- [x] done\n- [ ] |');
  });

  it('keeps the default inside the marker or checkbox and in code', () => {
    expect(run(continueListItem, '|- one').handled).toBe(false);
    expect(run(continueListItem, '1|. one').handled).toBe(false);
    expect(run(continueListItem, '- [|x] one').handled).toBe(false);
    expect(run(continueListItem, '- ```js|').handled).toBe(false);
  });
});

describe('Parsing empty items', () => {
  it('reads a bare bullet under a numbered item as an item, not a heading underline', () => {
    expect(run(exitEmptyListItem, '1. one\n   - |').text).toBe('1. one\n2. |');
  });

  it('reads a bare number under a bullet as an item', () => {
    expect(run(exitEmptyListItem, '- one\n  1. |').text).toBe('- one\n- |');
  });

  it('starts a list with a typed - or 1. right under a paragraph', () => {
    expect(blocks('Some text\n-')).toEqual(['Paragraph', 'BulletList', 'ListItem']);
    expect(blocks('Some text\n- ')).toEqual(['Paragraph', 'BulletList', 'ListItem']);
    expect(blocks('Some text\n1. ')).toEqual(['Paragraph', 'OrderedList', 'ListItem']);
    expect(blocks('> quoted\n> - ')).toEqual(['Paragraph', 'BulletList', 'ListItem']);
  });

  it('leaves other numbers and heading underlines to Markdown', () => {
    expect(blocks('Some text\n3. ')).toEqual(['Paragraph']);
    expect(blocks('Some text\n---')).toEqual(['SetextHeading2']);
  });
});

describe('Typing [] on an empty line or item', () => {
  it('turns an empty item into a task', () => {
    expect(run(typeSpace, '- one\n- []|').text).toBe('- one\n- [ ] |');
  });

  it('starts a task list on an empty line', () => {
    expect(run(typeSpace, '[]|').text).toBe('- [ ] |');
  });

  it('leaves [] inside text alone', () => {
    expect(run(typeSpace, 'a []|').handled).toBe(false);
  });
});

describe('Shift+Enter in a list item', () => {
  it('breaks the line under the item text', () => {
    expect(run(breakListItem, '- one|')).toEqual({ handled: true, text: '- one\n  |' });
    expect(run(breakListItem, '10. one|').text).toBe('10. one\n    |');
  });

  it('keeps nested items and quotes lined up', () => {
    expect(run(breakListItem, '> 1. one\n>    - two|').text).toBe('> 1. one\n>    - two\n>      |');
  });

  it('lines up with the bullet text of a task, which Markdown needs', () => {
    expect(run(breakListItem, '- [ ] one|').text).toBe('- [ ] one\n  |');
  });

  it('leaves code and plain text to the default', () => {
    expect(run(breakListItem, 'para|').handled).toBe(false);
    expect(run(breakListItem, '- one\n  ```\n  code|\n  ```').handled).toBe(false);
  });
});
