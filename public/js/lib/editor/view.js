/**
 * HedgeDoc's editor, built on CodeMirror 6.
 *
 * The application code (index.js, extra.js, syncscroll.js, the OT client, jquery-textcomplete,
 * inline-attachment) was written against the CodeMirror 5 API: `{line, ch}` positions,
 * `cm.getCursor()`, `cm.replaceRange()`, `cm.on('beforeChange')` and so on.
 * `HedgeDocEditor` keeps that small API surface on top of a CodeMirror 6 `EditorView`,
 * so that the rest of the application does not need to know about the underlying editor.
 * Everything that is specific to CodeMirror 6 (state, extensions, transactions) stays in here.
 */
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  showPanel
} from '@codemirror/view'
import { bracketMatching, codeFolding, foldGutter, indentUnit } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search } from '@codemirror/search'

import { Pass } from './pass'
import { authorshipExtension, setAuthorshipEffect } from './authorship'
import { commandTable, keyMapExtension } from './keymaps'
import { markdownLanguageSupport } from './markdown-language'
import { spellcheckExtension } from './spellcheck'
import { THEME_DARK, themeExtension } from './theme'

const MODE_DEFAULT = 'gfm'
const MODE_SPELLCHECK = 'spell-checker'

// Origin of a change, like the `origin` of a CodeMirror 5 change object
// (`setValue`, `ignoreHistory`, `+input`, ...). Programmatic changes set it explicitly,
// changes made by the user get it derived from CodeMirror's `userEvent`.
const originAnnotation = Annotation.define()

function originOf (transaction) {
  const origin = transaction.annotation(originAnnotation)
  if (origin) return origin
  const userEvent = transaction.annotation(Transaction.userEvent)
  if (!userEvent) return undefined
  if (userEvent.startsWith('delete')) return '+delete'
  if (userEvent.startsWith('input.paste')) return 'paste'
  if (userEvent.startsWith('input.drop')) return 'drop'
  if (userEvent.startsWith('input')) return '+input'
  return userEvent
}

// -- positions ---------------------------------------------------------------------------
// CodeMirror 5 style positions are `{line, ch}` with a zero-based line number.

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function posFromIndexIn (doc, index) {
  const line = doc.lineAt(clamp(index, 0, doc.length))
  return { line: line.number - 1, ch: clamp(index, 0, doc.length) - line.from }
}

function indexFromPosIn (doc, pos) {
  const line = doc.line(clamp(pos.line, 0, doc.lines - 1) + 1)
  // `ch` can be missing or beyond the line end, in which case the position is the line end
  const ch = pos.ch == null || isNaN(pos.ch) ? line.length : clamp(pos.ch, 0, line.length)
  return line.from + ch
}

class Range {
  constructor (anchor, head) {
    this.anchor = anchor
    this.head = head
  }

  from () {
    return comparePos(this.anchor, this.head) <= 0 ? this.anchor : this.head
  }

  to () {
    return comparePos(this.anchor, this.head) <= 0 ? this.head : this.anchor
  }

  empty () {
    return this.anchor.line === this.head.line && this.anchor.ch === this.head.ch
  }
}

function comparePos (a, b) {
  return a.line - b.line || a.ch - b.ch
}

// -- marks (`markText`) ------------------------------------------------------------------

const addMarkEffect = StateEffect.define()
const removeMarkEffect = StateEffect.define()

const marksField = StateField.define({
  create: () => Decoration.none,
  update (marks, transaction) {
    marks = marks.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(addMarkEffect)) {
        marks = marks.update({ add: [effect.value.decoration.range(effect.value.from, effect.value.to)] })
      } else if (effect.is(removeMarkEffect)) {
        marks = marks.update({ filter: (from, to, decoration) => decoration.spec.markId !== effect.value })
      }
    }
    return marks
  },
  provide: field => EditorView.decorations.from(field)
})

let markCounter = 0

// -- the editor --------------------------------------------------------------------------

const defaultOptions = {
  readOnly: true,
  indentUnit: 4,
  indentWithTabs: false,
  tabSize: 4,
  keyMap: 'sublime',
  theme: THEME_DARK,
  mode: MODE_DEFAULT,
  scrollbarStyle: 'overlay',
  viewportMargin: 20,
  foldGutter: true,
  fullScreen: false,
  maxLength: undefined,
  extraKeys: {},
  overrideBrowserKeymap: false
}

export default class HedgeDocEditor {
  /**
   * @param {HTMLElement} parent element the editor is appended to
   * @param {object} config
   * @param {string} [config.value] initial document
   * @param {string} [config.placeholder]
   * @param {boolean} [config.full] whether to enable the full set of editing features.
   *   `false` creates a plain read-only viewer (used for revisions).
   */
  constructor (parent, { value = '', placeholder: placeholderText, full = true } = {}) {
    this.options = Object.assign({}, defaultOptions)
    this.handlers = {}
    this.panels = []
    this.full = full
    // The OT client replaces these, see ot-adapter.js. Without a client there is no history.
    this.undo = () => {}
    this.redo = () => {}

    this.compartments = {
      readOnly: new Compartment(),
      indent: new Compartment(),
      keymap: new Compartment(),
      extraKeys: new Compartment(),
      theme: new Compartment(),
      spellcheck: new Compartment(),
      fold: new Compartment(),
      panels: new Compartment()
    }

    const extensions = [
      this.compartments.readOnly.of(EditorState.readOnly.of(this.options.readOnly)),
      this.compartments.indent.of(this._indentExtensions()),
      this.compartments.theme.of(themeExtension(this.options.theme)),
      this.compartments.spellcheck.of([]),
      this.compartments.panels.of([]),
      this.compartments.extraKeys.of([]),
      this.compartments.keymap.of([]),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      EditorView.editorAttributes.of({ class: 'CodeMirror' }),
      EditorView.contentAttributes.of({ class: 'CodeMirror-sizer' }),
      EditorView.updateListener.of(update => this._onUpdate(update)),
      EditorState.transactionFilter.of(transaction => this._filterTransaction(transaction)),
      EditorView.domEventHandlers({
        drop: (event) => this._emitDomEvent('drop', event),
        paste: (event) => this._emitDomEvent('paste', event),
        cut: (event) => this._emitDomEvent('cut', event)
      }),
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      markdownLanguageSupport(),
      marksField
    ]
    if (full) {
      extensions.push(
        authorshipExtension,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        bracketMatching(),
        closeBrackets(),
        dropCursor(),
        search({ top: true }),
        // order matters: the gutters are laid out in the order of their extensions
        this.compartments.fold.of(this._foldExtensions())
      )
      if (placeholderText) extensions.push(placeholder(placeholderText))
    } else {
      extensions.push(this.compartments.fold.of([]))
    }

    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: value, extensions })
    })
    this.view.scrollDOM.classList.add('CodeMirror-scroll')

    // Elements that are positioned in document coordinates: other users' cursors and the
    // auto-completion menu. They live inside the scroller, so they scroll along with the text.
    this.overlay = document.createElement('div')
    this.overlay.className = 'CodeMirror-overlay'
    this.otherCursorsElement = document.createElement('div')
    this.otherCursorsElement.className = 'CodeMirror-other-cursors'
    this.cursorsElement = document.createElement('div')
    this.cursorsElement.className = 'CodeMirror-cursors'
    this.overlay.appendChild(this.otherCursorsElement)
    this.overlay.appendChild(this.cursorsElement)
    this.view.scrollDOM.appendChild(this.overlay)

    if (full) {
      this._applyKeyMap()
      this._applyExtraKeys()
    }
  }

  // -- events ----------------------------------------------------------------------------

  on (event, callback) {
    (this.handlers[event] || (this.handlers[event] = [])).push(callback)
  }

  off (event, callback) {
    const list = this.handlers[event]
    if (!list) return
    const index = list.indexOf(callback)
    if (index !== -1) list.splice(index, 1)
  }

  _emit (event, ...args) {
    const list = this.handlers[event]
    if (!list) return
    // iterate over a copy, handlers may unregister themselves
    list.slice().forEach(callback => callback(this, ...args))
  }

  _emitDomEvent (event, domEvent) {
    const list = this.handlers[event]
    if (!list) return false
    let handled = false
    list.slice().forEach(callback => {
      if (callback(this, domEvent) === true) handled = true
    })
    return handled
  }

  _onUpdate (update) {
    // The order is relevant: a change is reported before the cursor movement it caused.
    if (update.docChanged) {
      this._emit('changes', this._describeChanges(update), update)
    }
    if (update.selectionSet || update.docChanged) {
      const doc = update.state.doc
      this._emit('beforeSelectionChange', {
        ranges: update.state.selection.ranges.map(range => ({
          anchor: posFromIndexIn(doc, range.anchor),
          head: posFromIndexIn(doc, range.head)
        }))
      })
      this._emit('cursorActivity')
    }
    if (update.focusChanged) {
      this._emit(update.view.hasFocus ? 'focus' : 'blur')
    }
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this._syncOverlay()
    }
    if (update.docChanged || update.viewportChanged || update.geometryChanged || update.heightChanged ||
      update.transactions.some(transaction => transaction.effects.length > 0)) {
      this._scheduleUpdateEvent()
    }
  }

  /**
   * Like CodeMirror 5's `update` event this reports that the display has been redrawn.
   * Marks that come in through effects (such as the authorship) are drawn after the
   * listeners ran, so the event is sent in the next frame, and only once for several updates.
   */
  _scheduleUpdateEvent () {
    if (this.updateEventPending) return
    this.updateEventPending = true
    requestAnimationFrame(() => {
      this.updateEventPending = false
      this._emit('update')
    })
  }

  _describeChanges (update) {
    const before = update.startState.doc
    const after = update.state.doc
    const changes = []
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      changes.push({
        from: posFromIndexIn(before, fromA),
        to: posFromIndexIn(before, toA),
        text: inserted.toJSON(),
        removed: before.slice(fromA, toA).toJSON(),
        newFrom: posFromIndexIn(after, fromB),
        origin: update.transactions.length ? originOf(update.transactions[0]) : undefined
      })
    })
    return changes
  }

  /**
   * Gives the `beforeChange` handlers the chance to cancel or rewrite a change before it is
   * applied, like CodeMirror 5's `beforeChange` event.
   */
  _filterTransaction (transaction) {
    const handlers = this.handlers.beforeChange
    if (!transaction.docChanged || !handlers || handlers.length === 0) return transaction

    const doc = transaction.startState.doc
    const origin = originOf(transaction)
    const changes = []
    transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      changes.push({
        from: posFromIndexIn(doc, fromA),
        to: posFromIndexIn(doc, toA),
        text: inserted.toJSON(),
        origin,
        canceled: false,
        updated: false,
        cancel () {
          this.canceled = true
        },
        update (from, to, text, newOrigin) {
          this.from = from
          this.to = to
          this.text = text
          if (newOrigin) this.origin = newOrigin
          this.updated = true
        }
      })
    })
    changes.forEach(change => handlers.slice().forEach(callback => callback(this, change)))

    if (changes.some(change => change.canceled)) return []
    if (!changes.some(change => change.updated)) return transaction

    const spec = {
      changes: changes.map(change => ({
        from: indexFromPosIn(doc, change.from),
        to: indexFromPosIn(doc, change.to),
        insert: change.text.join('\n')
      })),
      effects: transaction.effects,
      scrollIntoView: transaction.scrollIntoView,
      annotations: [
        originAnnotation.of(origin),
        Transaction.addToHistory.of(transaction.annotation(Transaction.addToHistory) !== false)
      ]
    }
    const userEvent = transaction.annotation(Transaction.userEvent)
    if (userEvent) spec.annotations.push(Transaction.userEvent.of(userEvent))
    if (changes.length === 1) {
      // keep the cursor behind the (rewritten) text, as it would have been for the original
      const [change] = changes
      spec.selection = EditorSelection.cursor(
        indexFromPosIn(doc, change.from) + change.text.join('\n').length
      )
    }
    return spec
  }

  // -- document --------------------------------------------------------------------------

  get doc () {
    const editor = this
    return {
      cm: editor,
      get height () {
        return editor.view.contentHeight
      }
    }
  }

  getValue () {
    return this.view.state.doc.toString()
  }

  setValue (value) {
    const doc = this.view.state.doc
    this.view.dispatch({
      changes: { from: 0, to: doc.length, insert: value },
      selection: EditorSelection.cursor(0),
      annotations: [originAnnotation.of('setValue'), Transaction.addToHistory.of(false)]
    })
  }

  // The editor has no history of its own: undo and redo are provided by the OT client
  // (see ot-adapter.js), which knows which changes were made by the local user.
  clearHistory () {}

  getHistory () {
    return null
  }

  setHistory () {}

  getLine (line) {
    const doc = this.view.state.doc
    if (line < 0 || line >= doc.lines) return undefined
    return doc.line(line + 1).text
  }

  lineCount () {
    return this.view.state.doc.lines
  }

  lastLine () {
    return this.view.state.doc.lines - 1
  }

  getRange (from, to) {
    const doc = this.view.state.doc
    return doc.sliceString(indexFromPosIn(doc, from), indexFromPosIn(doc, to))
  }

  /**
   * Replaces the text between `from` and `to` (or inserts at `from`).
   * @param {string} text
   * @param {{line: number, ch: number}} from
   * @param {{line: number, ch: number}} [to]
   * @param {string} [origin]
   */
  replaceRange (text, from, to, origin) {
    const doc = this.view.state.doc
    const fromIndex = indexFromPosIn(doc, from)
    const toIndex = to ? indexFromPosIn(doc, to) : fromIndex
    const changes = { from: Math.min(fromIndex, toIndex), to: Math.max(fromIndex, toIndex), insert: text }
    this._dispatchChanges(changes, origin)
  }

  replaceSelection (text) {
    const changes = this.view.state.selection.ranges.map(range => ({
      from: range.from,
      to: range.to,
      insert: text
    }))
    this._dispatchChanges(changes, '+input')
  }

  /**
   * Applies several changes at once. The positions of all changes refer to the document as it
   * is before the call (as opposed to `replaceRange`, which works step by step).
   * @param {Array<{from: number, to?: number, insert?: string}>} changes document offsets
   * @param {string} [origin]
   */
  applyChanges (changes, origin) {
    this._dispatchChanges(changes, origin)
  }

  _dispatchChanges (changes, origin) {
    const state = this.view.state
    const changeSet = state.changes(changes)
    // like in CodeMirror 5, a cursor at or inside a replaced range ends up behind the new text
    const ranges = state.selection.ranges.map(range => range.empty
      ? EditorSelection.cursor(changeSet.mapPos(range.head, 1))
      : range.map(changeSet))
    const annotations = [Transaction.addToHistory.of(origin !== 'ignoreHistory')]
    if (origin) annotations.push(originAnnotation.of(origin))
    this.view.dispatch({
      changes: changeSet,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      annotations
    })
  }

  posFromIndex (index) {
    return posFromIndexIn(this.view.state.doc, index)
  }

  indexFromPos (pos) {
    return indexFromPosIn(this.view.state.doc, pos)
  }

  // -- selection -------------------------------------------------------------------------

  getCursor (which = 'head') {
    const range = this.view.state.selection.main
    const doc = this.view.state.doc
    switch (which) {
      case 'anchor': return posFromIndexIn(doc, range.anchor)
      case 'from': return posFromIndexIn(doc, range.from)
      case 'to': return posFromIndexIn(doc, range.to)
      default: return posFromIndexIn(doc, range.head)
    }
  }

  setCursor (line, ch) {
    const pos = typeof line === 'object' ? line : { line, ch }
    this.view.dispatch({
      selection: EditorSelection.cursor(this.indexFromPos(pos)),
      scrollIntoView: true
    })
  }

  listSelections () {
    const doc = this.view.state.doc
    return this.view.state.selection.ranges.map(range =>
      new Range(posFromIndexIn(doc, range.anchor), posFromIndexIn(doc, range.head)))
  }

  setSelections (ranges, primary) {
    if (!ranges || ranges.length === 0) return
    const doc = this.view.state.doc
    this.view.dispatch({
      selection: EditorSelection.create(
        ranges.map(range => EditorSelection.range(
          indexFromPosIn(doc, range.anchor),
          indexFromPosIn(doc, range.head))),
        primary == null ? ranges.length - 1 : primary),
      scrollIntoView: true
    })
  }

  getSelection () {
    return this.getSelections().join('\n')
  }

  getSelections () {
    const doc = this.view.state.doc
    return this.view.state.selection.ranges.map(range => doc.sliceString(range.from, range.to))
  }

  somethingSelected () {
    return this.view.state.selection.ranges.some(range => !range.empty)
  }

  // -- view ------------------------------------------------------------------------------

  focus () {
    this.view.focus()
  }

  hasFocus () {
    return this.view.hasFocus
  }

  refresh () {
    this.view.requestMeasure()
  }

  /** Runs `callback` (CodeMirror 5 used this to batch updates, there is nothing to batch here). */
  operation (callback) {
    return callback()
  }

  getWrapperElement () {
    return this.view.dom
  }

  getScrollerElement () {
    return this.view.scrollDOM
  }

  /** The element that receives the keyboard input. */
  getInputField () {
    return this.view.contentDOM
  }

  /**
   * Only the width can be set. The height of the editor is always determined by its panels
   * and the height of the scroller (see checkEditorStyle in index.js), the same way the
   * stylesheet did not allow CodeMirror 5 to apply a fixed height.
   */
  setSize (width) {
    if (width != null) this.view.dom.style.width = typeof width === 'number' ? width + 'px' : width
    this.view.requestMeasure()
  }

  defaultTextHeight () {
    return this.view.defaultLineHeight
  }

  getScrollInfo () {
    const scroller = this.view.scrollDOM
    return {
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      width: scroller.scrollWidth,
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth
    }
  }

  scrollTo (x, y) {
    const scroller = this.view.scrollDOM
    if (x != null) scroller.scrollLeft = x
    if (y != null) scroller.scrollTop = y
  }

  scrollIntoView () {
    this.view.dispatch({
      effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'nearest' })
    })
  }

  /** Top of the given line, relative to the top of the document. */
  heightAtLine (line) {
    const doc = this.view.state.doc
    if (line >= doc.lines) {
      const block = this.view.lineBlockAt(doc.length)
      return block.bottom
    }
    return this.view.lineBlockAt(doc.line(Math.max(line, 0) + 1).from).top
  }

  /**
   * Coordinates of a position relative to the text area (and the top of the document).
   * These are the coordinates elements inside `.CodeMirror-overlay` are placed with.
   */
  charCoords (pos) {
    const view = this.view
    const index = this.indexFromPos(pos)
    const lineHeight = view.defaultLineHeight
    const coords = view.coordsAtPos(index)
    const padding = view.documentPadding.top
    if (coords) {
      const left = coords.left - view.contentDOM.getBoundingClientRect().left
      const top = coords.top - view.documentTop + padding
      return { left, right: left, top, bottom: top + (coords.bottom - coords.top) }
    }
    // not rendered (outside of the viewport): the line is known, the column is not
    const top = view.lineBlockAt(index).top + padding
    return { left: 0, right: 0, top, bottom: top + lineHeight }
  }

  _syncOverlay () {
    this.overlay.style.left = this.view.contentDOM.offsetLeft + 'px'
    // Other users' cursors and the completion menu remember the position they point to
    // (data-line / data-ch) and are moved along when the text above them changes.
    const anchored = this.overlay.querySelectorAll('.CodeMirror-other-cursor')
    for (let i = 0; i < anchored.length; i++) {
      const element = anchored[i]
      const line = parseInt(element.getAttribute('data-line'))
      const ch = parseInt(element.getAttribute('data-ch'))
      if (isNaN(line) || isNaN(ch)) continue
      const offsetLeft = parseFloat(element.getAttribute('data-offset-left')) || 0
      const offsetTop = parseFloat(element.getAttribute('data-offset-top')) || 0
      const coords = this.charCoords({ line, ch })
      element.style.left = coords.left + offsetLeft + 'px'
      element.style.top = coords.top + offsetTop + 'px'
    }
  }

  // -- marks -----------------------------------------------------------------------------

  /**
   * Styles a part of the text.
   * @param {{line: number, ch: number}} from
   * @param {{line: number, ch: number}} to
   * @param {{className?: string, css?: string, title?: string}} options
   * @returns {{clear: function}}
   */
  markText (from, to, { className, css, title } = {}) {
    const doc = this.view.state.doc
    const markId = ++markCounter
    const attributes = {}
    if (css) attributes.style = css
    if (title) attributes.title = title
    const decoration = Decoration.mark({ class: className, attributes, markId })
    const fromIndex = indexFromPosIn(doc, from)
    const toIndex = indexFromPosIn(doc, to)
    if (fromIndex < toIndex) {
      this.view.dispatch({
        effects: addMarkEffect.of({ decoration, from: fromIndex, to: toIndex }),
        annotations: Transaction.addToHistory.of(false)
      })
    }
    return {
      clear: () => this.view.dispatch({ effects: removeMarkEffect.of(markId) })
    }
  }

  /**
   * Replaces the authorship marks. The lines and passages are given as positions.
   * @param {{lines: Array<{line: number, className: string, name: string}>,
   *   inline: Array<{from: {line: number, ch: number}, to: {line: number, ch: number}, className: string, name: string}>}} marks
   */
  setAuthorship ({ lines, inline }) {
    const doc = this.view.state.doc
    this.view.dispatch({
      effects: setAuthorshipEffect.of({
        lines: lines.map(entry => ({
          from: doc.line(clamp(entry.line, 0, doc.lines - 1) + 1).from,
          className: entry.className,
          name: entry.name
        })),
        inline: inline.map(entry => ({
          from: indexFromPosIn(doc, entry.from),
          to: indexFromPosIn(doc, entry.to),
          className: entry.className,
          name: entry.name
        }))
      }),
      annotations: Transaction.addToHistory.of(false)
    })
  }

  /**
   * Draws markers for the given ranges next to the scrollbar (like the annotations of the
   * CodeMirror 5 `annotatescrollbar` addon). Used by the revision viewer.
   */
  annotateScrollbar ({ className }) {
    const track = document.createElement('div')
    track.className = 'CodeMirror-annotation-track'
    this.view.dom.appendChild(track)
    return {
      update: ranges => {
        track.textContent = ''
        // a document shorter than the editor is scaled like a document of the editor's height
        const total = Math.max(this.heightAtLine(this.lastLine() + 1), this.view.scrollDOM.clientHeight, 1)
        ranges.forEach(range => {
          const top = this.heightAtLine(range.from.line)
          const bottom = this.heightAtLine(range.to.line + 1)
          const marker = document.createElement('div')
          marker.className = className
          marker.style.top = (top / total * 100) + '%'
          marker.style.height = 'max(3px, ' + ((bottom - top) / total * 100) + '%)'
          track.appendChild(marker)
        })
      },
      clear: () => track.remove()
    }
  }

  // -- panels (tool bar, status bar) -----------------------------------------------------

  /**
   * Adds a panel above or below the text.
   * @param {HTMLElement} node
   * @param {{position?: 'top'|'bottom'}} [options]
   */
  addPanel (node, { position = 'top' } = {}) {
    const panel = { node, top: position === 'top' }
    this.panels.push(panel)
    this._applyPanels()
    return {
      clear: () => {
        this.panels.splice(this.panels.indexOf(panel), 1)
        this._applyPanels()
      }
    }
  }

  _applyPanels () {
    this.view.dispatch({
      effects: this.compartments.panels.reconfigure(
        this.panels.map(panel => showPanel.of(() => ({ dom: panel.node, top: panel.top }))))
    })
  }

  // -- options ---------------------------------------------------------------------------

  getOption (name) {
    return this.options[name]
  }

  setOption (name, value) {
    const previous = this.options[name]
    this.options[name] = value
    switch (name) {
      case 'readOnly':
        this._reconfigure('readOnly', EditorState.readOnly.of(!!value))
        break
      case 'indentUnit':
      case 'indentWithTabs':
      case 'tabSize':
        this._reconfigure('indent', this._indentExtensions())
        break
      case 'keyMap':
        this._applyKeyMap()
        break
      case 'extraKeys':
        this._applyExtraKeys()
        break
      case 'theme':
        this._reconfigure('theme', themeExtension(value))
        break
      case 'mode':
        this._reconfigure('spellcheck', value === MODE_SPELLCHECK ? spellcheckExtension() : [])
        break
      case 'foldGutter':
        if (this.full) this._reconfigure('fold', this._foldExtensions())
        break
      case 'fullScreen':
        this._setFullScreen(!!value)
        break
      case 'overrideBrowserKeymap':
        if (previous !== value) this._applyKeyMap()
        break
      default:
        // `scrollbarStyle`, `viewportMargin`, `maxLength`: only the application reads them
        break
    }
  }

  _reconfigure (compartment, extension) {
    this.view.dispatch({
      effects: this.compartments[compartment].reconfigure(extension),
      annotations: Transaction.addToHistory.of(false)
    })
  }

  _indentExtensions () {
    const { indentUnit: unit, indentWithTabs, tabSize } = this.options
    return [
      indentUnit.of(indentWithTabs ? '\t' : ' '.repeat(parseInt(unit) || 4)),
      EditorState.tabSize.of(parseInt(tabSize) || 4)
    ]
  }

  _foldExtensions () {
    if (!this.options.foldGutter) return []
    return [
      codeFolding({
        placeholderDOM (view, onclick) {
          const element = document.createElement('span')
          element.className = 'CodeMirror-foldmarker'
          element.textContent = '↔'
          element.onclick = onclick
          return element
        }
      }),
      foldGutter({
        markerDOM (open) {
          const element = document.createElement('span')
          element.className = open ? 'CodeMirror-foldgutter-open' : 'CodeMirror-foldgutter-folded'
          return element
        }
      })
    ]
  }

  _applyKeyMap () {
    this._reconfigure('keymap', keyMapExtension(this.options.keyMap, this, {
      overrideBrowserKeymap: this.options.overrideBrowserKeymap
    }))
  }

  /**
   * `extraKeys` are bindings that take precedence over the keymap. A handler receives the
   * editor and may return `Pass` to let the next binding handle the key. A binding can also
   * name a command as string.
   */
  _applyExtraKeys () {
    const bindings = []
    const extraKeys = this.options.extraKeys || {}
    Object.keys(extraKeys).forEach(name => {
      const handler = extraKeys[name]
      bindings.push({
        key: convertKeyName(name),
        run: () => typeof handler === 'string'
          ? this.execCommand(handler)
          : handler(this) !== Pass,
        preventDefault: true
      })
    })
    this._reconfigure('extraKeys', Prec.highest(keymap.of(bindings)))
  }

  execCommand (name) {
    if (name === 'undo') {
      this.undo()
      return true
    }
    if (name === 'redo') {
      this.redo()
      return true
    }
    const command = commandTable[name]
    return command ? command(this.view) : false
  }

  _setFullScreen (fullScreen) {
    this.view.dom.classList.toggle('CodeMirror-fullscreen', fullScreen)
    document.documentElement.style.overflow = fullScreen ? 'hidden' : ''
    this.view.requestMeasure()
  }

  destroy () {
    this.view.destroy()
  }
}

// CodeMirror 5 key names -> CodeMirror 6 key names (`Cmd-Left` -> `Meta-ArrowLeft`)
const keyAliases = {
  Esc: 'Escape',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Del: 'Delete',
  Space: ' '
}

export function convertKeyName (name) {
  const match = /^((?:(?:Shift|Ctrl|Cmd|Alt|Mod|Meta)-)*)(.+)$/.exec(name)
  const modifiers = match[1].replace(/Cmd-/g, 'Meta-')
  let key = keyAliases[match[2]] || match[2]
  // `Ctrl-S` meant Ctrl and the key `s`, while CodeMirror 6 compares with the key as typed
  if (/^[A-Z]$/.test(key)) key = key.toLowerCase()
  return modifiers + key
}

export { Pass, MODE_DEFAULT, MODE_SPELLCHECK }
