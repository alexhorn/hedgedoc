import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { LanguageDescription } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const DOLLAR = 36
const BACKSLASH = 92
const SPACE = 32
const CONTAINER_FENCE = /^:{3,}[ \t]*\w*[ \t]*$/

// Extra syntax that HedgeDoc understands on top of GitHub flavoured markdown:
// YAML front matter, $inline$ / $$display$$ math and ::: containers.
const hedgedocSyntax = {
  defineNodes: [
    { name: 'Frontmatter', block: true, style: t.meta },
    { name: 'BlockMath', block: true, style: t.special(t.string) },
    { name: 'InlineMath', style: t.special(t.string) },
    { name: 'ContainerMark', block: true, style: t.processingInstruction }
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse (cx, line) {
        // front matter is only valid at the very beginning of the document
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false
        const doc = cx.input.read(0, cx.input.length)
        const match = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(doc)
        if (!match) return false
        const end = match[0].replace(/\r?\n$/, '').length
        while (cx.nextLine()) {
          if (cx.lineStart > end) break
        }
        cx.addElement(cx.elt('Frontmatter', 0, end))
        return true
      }
    },
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse (cx, line) {
        // opening `$$` that is not closed on the same line
        if (!/^\$\$(?!.*\$\$)/.test(line.text.slice(line.pos))) return false
        const from = cx.lineStart + line.pos
        while (cx.nextLine() && line.depth >= cx.stack.length) {
          if (/^\s*\$\$\s*$/.test(line.text)) {
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd()))
        return true
      }
    },
    {
      name: 'ContainerMark',
      before: 'FencedCode',
      // a container fence ends a paragraph, like in the renderer
      endLeaf: (cx, line) => CONTAINER_FENCE.test(line.text.slice(line.pos)),
      parse (cx, line) {
        if (!CONTAINER_FENCE.test(line.text.slice(line.pos))) return false
        const from = cx.lineStart + line.pos
        const to = cx.lineStart + line.text.length
        cx.nextLine()
        cx.addElement(cx.elt('ContainerMark', from, to))
        return true
      }
    }
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Escape',
      parse (cx, next, pos) {
        if (next !== DOLLAR) return -1
        const display = cx.char(pos + 1) === DOLLAR
        const open = display ? 2 : 1
        const limit = cx.end
        let end = pos + open
        while (end < limit) {
          const ch = cx.char(end)
          if (ch === BACKSLASH) {
            end += 2
            continue
          }
          if (ch === DOLLAR && (!display || cx.char(end + 1) === DOLLAR)) break
          end++
        }
        if (end >= limit || end === pos + open) return -1
        // `$ 5 and 6 $` is prose, `$x$` is math
        if (!display && (cx.char(pos + 1) === SPACE || cx.char(end - 1) === SPACE)) return -1
        return cx.addElement(cx.elt('InlineMath', pos, end + open))
      }
    }
  ]
}

// Code fences in HedgeDoc may carry a suffix like `javascript=`, `js=10+` or `python!`
// (line numbers / wrapping hints). Only the language name is relevant for highlighting.
function findCodeLanguage (info) {
  const name = info.replace(/[=!+].*$/, '').trim()
  if (!name) return null
  return LanguageDescription.matchLanguageName(languages, name, true)
}

export function markdownLanguageSupport () {
  return markdown({
    base: markdownLanguage,
    codeLanguages: findCodeLanguage,
    extensions: [hedgedocSyntax],
    // list continuation etc. is handled through the markdown keymap
    addKeymap: false
  })
}
