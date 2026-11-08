/**
 * Connects the editor to the operational transformation client (public/vendor/ot).
 * It translates between the editor's changes and selections and the OT library's
 * text operations and selections.
 */
import { EditorSelection } from '@codemirror/state'
import { ot } from '../../../vendor/ot/ot.min.js'
import hex2rgb from '../../../vendor/ot/hex2rgb'

const TextOperation = ot.TextOperation
const Selection = ot.Selection

// CSS rules for the selections of other users are created on demand, one per colour
const addStyleRule = (function () {
  const added = {}
  const styleElement = document.createElement('style')
  document.documentElement.getElementsByTagName('head')[0].appendChild(styleElement)
  const styleSheet = styleElement.sheet

  return function (css) {
    if (added[css]) return
    added[css] = true
    styleSheet.insertRule(css, (styleSheet.cssRules || styleSheet.rules).length)
  }
}())

/**
 * Converts the changes of one editor update into an operation and its inverse.
 * @param {ChangeSet} changes the changes, from `startDoc` to the new document
 * @param {Text} startDoc the document before the changes
 * @returns {[TextOperation, TextOperation]}
 */
export function operationFromChanges (changes, startDoc) {
  const operation = new TextOperation()
  const inverse = new TextOperation()
  // current position in the old and in the new document
  let oldPos = 0
  let newPos = 0
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const removedText = startDoc.sliceString(fromA, toA)
    const insertedText = inserted.toString()

    operation.retain(fromA - oldPos)
    if (toA > fromA) operation.delete(toA - fromA)
    if (insertedText) operation.insert(insertedText)

    inverse.retain(fromB - newPos)
    if (toB > fromB) inverse.delete(toB - fromB)
    if (removedText) inverse.insert(removedText)

    oldPos = toA
    newPos = toB
  })
  operation.retain(startDoc.length - oldPos)
  inverse.retain(changes.newLength - newPos)
  return [operation, inverse]
}

/**
 * Converts an operation into changes for the editor. All positions refer to the document
 * the operation is applied to, which is what the editor expects.
 * @param {TextOperation} operation
 * @returns {Array<{from: number, to?: number, insert?: string}>}
 */
export function changesFromOperation (operation) {
  const changes = []
  let index = 0
  operation.ops.forEach(op => {
    if (TextOperation.isRetain(op)) {
      index += op
    } else if (TextOperation.isInsert(op)) {
      changes.push({ from: index, insert: op })
    } else if (TextOperation.isDelete(op)) {
      changes.push({ from: index, to: index - op })
      index -= op
    }
  })
  return changes
}

export default class CodeMirrorAdapter {
  constructor (cm) {
    this.cm = cm
    // set by the application to keep the next change from being sent to the server
    this.ignoreNextChange = false
    this.callbacks = null

    this.onChanges = this.onChanges.bind(this)
    this.onCursorActivity = this.onCursorActivity.bind(this)
    this.onFocus = this.onFocus.bind(this)
    this.onBlur = this.onBlur.bind(this)

    // `changes` is emitted before `cursorActivity`, so that an operation is always
    // reported before the selection change it caused
    cm.on('changes', this.onChanges)
    cm.on('cursorActivity', this.onCursorActivity)
    cm.on('focus', this.onFocus)
    cm.on('blur', this.onBlur)
  }

  detach () {
    this.cm.off('changes', this.onChanges)
    this.cm.off('cursorActivity', this.onCursorActivity)
    this.cm.off('focus', this.onFocus)
    this.cm.off('blur', this.onBlur)
  }

  registerCallbacks (callbacks) {
    this.callbacks = callbacks
  }

  trigger (event, ...args) {
    const action = this.callbacks && this.callbacks[event]
    if (action) action.apply(this, args)
  }

  onChanges (cm, changes, update) {
    if (!this.ignoreNextChange) {
      const [operation, inverse] = operationFromChanges(update.changes, update.startState.doc)
      this.trigger('change', operation, inverse)
    }
    this.ignoreNextChange = false
  }

  onCursorActivity () {
    this.trigger('selectionChange')
  }

  onFocus () {
    this.trigger('selectionChange')
  }

  onBlur () {
    if (!this.cm.somethingSelected()) {
      this.trigger('blur')
    }
  }

  getValue () {
    return this.cm.getValue()
  }

  getSelection () {
    const ranges = this.cm.view.state.selection.ranges.map(range =>
      new Selection.Range(range.anchor, range.head))
    return new Selection(ranges)
  }

  setSelection (selection) {
    if (!selection || selection.ranges.length === 0) return
    const view = this.cm.view
    const length = view.state.doc.length
    const clip = position => Math.max(0, Math.min(length, position))
    view.dispatch({
      selection: EditorSelection.create(
        selection.ranges.map(range => EditorSelection.range(clip(range.anchor), clip(range.head))),
        selection.ranges.length - 1)
    })
  }

  applyOperation (operation) {
    if (!operation.isNoop()) {
      this.ignoreNextChange = true
    }
    this.cm.applyChanges(changesFromOperation(operation), 'ignoreHistory')
  }

  // Selections of other users are shown as a tinted background. Their cursors are
  // drawn by the application (see buildCursor in index.js).
  setOtherSelection (selection, color, clientId) {
    const marks = []
    selection.ranges.forEach(range => {
      if (range.isEmpty()) return
      const match = /^#([0-9a-fA-F]{6})$/.exec(color)
      if (!match) {
        throw new Error('only six-digit hex colors are allowed.')
      }
      const className = 'selection-' + match[1]
      const rgb = hex2rgb(color)
      addStyleRule('.' + className + ' { background: rgba(' + rgb.red + ',' + rgb.green + ',' + rgb.blue + ',0.2); }')
      const from = Math.min(range.anchor, range.head)
      const to = Math.max(range.anchor, range.head)
      marks.push(this.cm.markText(this.cm.posFromIndex(from), this.cm.posFromIndex(to), { className }))
    })
    return {
      clear () {
        marks.forEach(mark => mark.clear())
      }
    }
  }

  registerUndo (undoFunction) {
    this.cm.undo = undoFunction
  }

  registerRedo (redoFunction) {
    this.cm.redo = redoFunction
  }
}
