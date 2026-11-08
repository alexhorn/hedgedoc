import { EditorView } from '@codemirror/view'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'

// Structure shared by all themes. Colours are supplied by the individual theme.
// Font family, size and line height live in css/index.css (`.CodeMirror`), so that
// they can be adjusted per language there.
const layout = EditorView.theme({
  '&': {
    height: 'auto'
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflowX: 'hidden'
  },
  '.cm-content': {
    // allow scrolling a bit past the last line, so the text is not stuck to the status bar
    paddingBottom: '36px'
  },
  '.cm-gutters': {
    // the line number gutter keeps its colours from the theme, but must not draw a border
    borderRight: 'none'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '1.5em',
    textAlign: 'right'
  },
  '.cm-placeholder': {
    color: '#777'
  },
  '.cm-selectionMatch': {
    backgroundColor: 'transparent',
    borderBottom: '1px solid #ccc'
  }
})

const light = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#000000'
  },
  '.cm-gutters': {
    backgroundColor: '#f7f7f7',
    color: '#999999'
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(0, 0, 0, 0.04)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(0, 0, 0, 0.06)'
  },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: '#d7d4f0'
  }
}, { dark: false })

export const THEME_DARK = 'one-dark'
export const THEME_LIGHT = 'default'

export function themeExtension (name) {
  if (name === THEME_LIGHT) {
    return [layout, light, syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
  }
  return [layout, oneDark]
}
