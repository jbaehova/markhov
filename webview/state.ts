import { type EditorState, Facet, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Resources } from '../src/protocol';

export const setFocus = StateEffect.define<boolean>();

/** Forces decorations to rebuild, e.g. after an IME composition ends. */
export const refresh = StateEffect.define<null>();

export const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocus)) value = effect.value;
    return value;
  },
});

export const focusTracking = [focusField, EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing))];

export const resourcesFacet = Facet.define<Resources, Resources>({
  combine: (values) => values[0] ?? { baseUri: null, workspaceUri: null },
});

/** True when the editor is focused and a selection range touches [from, to]. */
export function touches(state: EditorState, from: number, to: number): boolean {
  if (!state.field(focusField, false)) return false;
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

export function lineTouches(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

export function needsRebuild(tr: { effects: readonly StateEffect<unknown>[] }): boolean {
  return tr.effects.some((e) => e.is(setFocus) || e.is(refresh));
}
