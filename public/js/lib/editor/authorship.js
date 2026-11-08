import { StateEffect, StateField, RangeSet, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view'

/**
 * Authorship display: a coloured bar in the gutter next to lines written by one author,
 * and an underline below passages written by somebody else than the line's main author.
 *
 * The marks are computed by the application (see updateAuthorshipInner in index.js) and
 * handed over via `setAuthorshipEffect`. Between two updates they follow the document edits.
 */

// payload: { lines: [{ from: <index of the line start>, className, name }],
//            inline: [{ from, to, className, name }] }  (indices into the document)
export const setAuthorshipEffect = StateEffect.define()

// CodeMirror ships native ES2015 classes, which cannot be extended by the classes that
// Babel compiles for this bundle. So the markers are plain `GutterMarker` instances
// that override the methods CodeMirror calls.
function createAuthorMarker (className, name) {
  const marker = new GutterMarker()
  marker.className = className
  marker.name = name
  marker.eq = other => other.className === className && other.name === name
  marker.toDOM = () => {
    const element = document.createElement('div')
    element.className = 'authorship-gutter ' + className
    element.title = name
    return element
  }
  return marker
}

const emptyMarker = new GutterMarker()
emptyMarker.toDOM = () => document.createElement('div')

function build ({ lines, inline }) {
  const gutterBuilder = new RangeSetBuilder()
  const sortedLines = lines.slice().sort((a, b) => a.from - b.from)
  for (const line of sortedLines) {
    gutterBuilder.add(line.from, line.from, createAuthorMarker(line.className, line.name))
  }
  const decorations = inline
    .filter(mark => mark.to > mark.from)
    .map(mark => Decoration.mark({
      class: 'authorship-inline ' + mark.className,
      attributes: { title: mark.name }
    }).range(mark.from, mark.to))
  return {
    gutter: gutterBuilder.finish(),
    inline: Decoration.set(decorations, true)
  }
}

const authorshipField = StateField.define({
  create: () => ({ gutter: RangeSet.empty, inline: Decoration.none }),
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setAuthorshipEffect)) return build(effect.value)
    }
    if (transaction.docChanged) {
      return {
        gutter: value.gutter.map(transaction.changes),
        inline: value.inline.map(transaction.changes)
      }
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value.inline)
})

export const authorshipExtension = [
  authorshipField,
  gutter({
    class: 'authorship-gutters',
    markers: view => view.state.field(authorshipField).gutter,
    initialSpacer: () => emptyMarker
  })
]
