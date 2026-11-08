import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import {
  defaultKeymap,
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineDown,
  cursorLineUp,
  deleteCharBackward,
  insertTab
} from '@codemirror/commands'
import { closeBracketsKeymap } from '@codemirror/autocomplete'
import { foldKeymap } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { markdownKeymap, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { vim } from '@replit/codemirror-vim'
import { emacs } from '@replit/codemirror-emacs'

// Maps the command names HedgeDoc used to run on CodeMirror 5 to CodeMirror 6 commands.
// `undo` and `redo` are routed through the editor facade, because the operational
// transformation client owns the undo stack (see ot-adapter.js).
export const commandTable = {
  goLineUp: cursorLineUp,
  goLineDown: cursorLineDown,
  goCharLeft: cursorCharLeft,
  goCharRight: cursorCharRight,
  delCharBefore: deleteCharBackward,
  goLineLeftSmart: cursorLineBoundaryBackward,
  goLineRight: cursorLineBoundaryForward,
  defaultTab: insertTab,
  newlineAndIndentContinueMarkdownList: insertNewlineContinueMarkup
}

// The key that, in the default keymap, would swallow the browser shortcut for
// "jump to address bar" (Ctrl-L / Cmd-L).
const ADDRESS_BAR_KEY = 'Mod-l'

function baseBindings ({ overrideBrowserKeymap }) {
  const bindings = [
    ...closeBracketsKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...defaultKeymap
  ]
  return overrideBrowserKeymap
    ? bindings
    : bindings.filter(binding => binding.key !== ADDRESS_BAR_KEY)
}

function undoRedoBindings (editor) {
  const undo = () => { editor.undo(); return true }
  const redo = () => { editor.redo(); return true }
  return [
    { key: 'Mod-z', run: undo, preventDefault: true },
    { key: 'Mod-y', run: redo, preventDefault: true },
    { key: 'Mod-Shift-z', run: redo, preventDefault: true }
  ]
}

/**
 * Builds the extension for one of the keymaps selectable in the status bar.
 * @param {string} name `sublime`, `emacs` or `vim`
 * @param {object} editor the editor facade (needed for undo/redo)
 * @param {{overrideBrowserKeymap: boolean}} options
 */
export function keyMapExtension (name, editor, options) {
  const common = [
    // Enter continues lists / quotes, Backspace removes markup. These beat the default bindings.
    Prec.high(keymap.of(markdownKeymap)),
    keymap.of([...undoRedoBindings(editor), ...baseBindings(options)])
  ]
  switch (name) {
    case 'vim':
      return [Prec.high(vim({ status: false })), ...common]
    case 'emacs':
      return [Prec.high(emacs()), ...common]
    default:
      return common
  }
}
