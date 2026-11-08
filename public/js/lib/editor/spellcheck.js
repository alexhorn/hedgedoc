/* global serverurl */
import Typo from 'typo-js'
import { StateEffect } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

// The English dictionary is loaded lazily, the first time spell checking is switched on.
const dictionaryFiles = {
  aff: '/vendor/codemirror-spell-checker/en_US.aff',
  dic: '/vendor/codemirror-spell-checker/en_US.dic'
}

let typo = null
let loadStarted = false
const waiting = new Set()

function fetchText (path) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('GET', serverurl + path, true)
    request.onload = () => {
      if (request.status === 200) resolve(request.responseText)
      else reject(new Error('Could not load ' + path))
    }
    request.onerror = () => reject(new Error('Could not load ' + path))
    request.send(null)
  })
}

function loadDictionary () {
  if (loadStarted) return
  loadStarted = true
  Promise.all([fetchText(dictionaryFiles.aff), fetchText(dictionaryFiles.dic)])
    .then(([aff, dic]) => {
      typo = new Typo('en_US', aff, dic, { platform: 'any' })
      waiting.forEach(notify => notify())
      waiting.clear()
    })
    .catch(error => {
      // allow another attempt on the next activation
      loadStarted = false
      console.warn(error)
    })
}

const dictionaryLoaded = StateEffect.define()

// Parts of the document that must not be spell checked.
const IGNORED_NODES = new Set([
  'InlineCode', 'CodeText', 'CodeInfo', 'CodeMark', 'FencedCode', 'CodeBlock',
  'URL', 'Autolink', 'HTMLTag', 'HTMLBlock', 'CommentBlock', 'Comment',
  'Frontmatter', 'InlineMath', 'BlockMath', 'ContainerMark'
])

// Characters separating words (same set as the former CodeMirror 5 spell checker).
const WORD = /[^!"#$%&()*+,\-./:;<=>?@[\\\]^_`{|}~\s]+/g
const CHECKABLE = /^[A-Za-z][A-Za-z0-9']+$/

const spellError = Decoration.mark({ class: 'cm-spell-error' })

function ignoredRanges (view, from, to) {
  const ranges = []
  syntaxTree(view.state).iterate({
    from,
    to,
    enter (node) {
      if (IGNORED_NODES.has(node.name)) {
        ranges.push([node.from, node.to])
        return false
      }
    }
  })
  return ranges
}

function findMisspelledWords (view) {
  const decorations = []
  if (!typo) return Decoration.none
  for (const { from, to } of view.visibleRanges) {
    const ignored = ignoredRanges(view, from, to)
    const text = view.state.doc.sliceString(from, to)
    let match
    WORD.lastIndex = 0
    while ((match = WORD.exec(text)) !== null) {
      const word = match[0]
      if (!CHECKABLE.test(word) || typo.check(word)) continue
      const start = from + match.index
      const end = start + word.length
      if (ignored.some(([ignoredFrom, ignoredTo]) => start < ignoredTo && end > ignoredFrom)) continue
      decorations.push(spellError.range(start, end))
    }
  }
  return Decoration.set(decorations, true)
}

const spellcheckPlugin = ViewPlugin.fromClass(class {
  constructor (view) {
    this.view = view
    this.notify = () => view.dispatch({ effects: dictionaryLoaded.of(null) })
    this.decorations = findMisspelledWords(view)
    if (!typo) {
      waiting.add(this.notify)
      loadDictionary()
    }
  }

  update (update) {
    const loaded = update.transactions.some(tr => tr.effects.some(effect => effect.is(dictionaryLoaded)))
    if (update.docChanged || update.viewportChanged || loaded) {
      this.decorations = findMisspelledWords(update.view)
    }
  }

  destroy () {
    waiting.delete(this.notify)
  }
}, {
  decorations: plugin => plugin.decorations
})

export function spellcheckExtension () {
  return spellcheckPlugin
}
