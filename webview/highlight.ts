import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Only code tokens are styled here. Markdown structure is styled by the
// live preview decorations, so markdown tags are deliberately left out.
// Note: t.meta is avoided because markdown marks (processingInstruction) inherit from it.
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], class: 'mh-tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'mh-tok-string' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'mh-tok-comment' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], class: 'mh-tok-number' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'mh-tok-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'mh-tok-type' },
  { tag: [t.propertyName, t.attributeName], class: 'mh-tok-property' },
  { tag: [t.tagName, t.angleBracket], class: 'mh-tok-tag' },
  { tag: [t.annotation, t.self, t.constant(t.variableName)], class: 'mh-tok-meta' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], class: 'mh-tok-punct' },
  { tag: [t.inserted], class: 'mh-tok-inserted' },
  { tag: [t.deleted], class: 'mh-tok-deleted' },
]);
