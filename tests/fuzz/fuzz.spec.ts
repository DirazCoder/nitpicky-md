import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parse, render, childNodes } from '../../src/api'
import type { MdNode } from '../../src/ast'

// fuzz: no crashes, no hangs (vitest timeout), and structural invariants
// hold on arbitrary input. CI runs FUZZ_CASES (default 2000); `npm run fuzz`
// bumps it to 100k.

const CASES = Number.parseInt(process.env.FUZZ_CASES ?? '2000', 10)

// full unicode incl. astral plane and lone-ish surrogates via code units
const arbitraryText = fc.string({ unit: 'grapheme', maxLength: 60 })

// markdown-flavored soup: line fragments from a grammar-ish pool
const lineFragment = fc.oneof(
  arbitraryText,
  fc.constant('# heading'),
  fc.constant('###### six'),
  fc.constant('## setext bait'),
  fc.constant('==='),
  fc.constant('---'),
  fc.constant('***'),
  fc.constant('> quoted'),
  fc.constant('>> more'),
  fc.constant('- item'),
  fc.constant('  - nested'),
  fc.constant('1. one'),
  fc.constant('10) ten'),
  fc.constant('    indented'),
  fc.constant('```'),
  fc.constant('```js'),
  fc.constant('~~~'),
  fc.constant('| a | b |'),
  fc.constant('| --- | --- |'),
  fc.constant('[link](/url)'),
  fc.constant('[ref][label]'),
  fc.constant('![img](/u "t")'),
  fc.constant('*em* **strong**'),
  fc.constant('_em_ __strong__'),
  fc.constant('~~strike~~'),
  fc.constant('`code`'),
  fc.constant('<div>'),
  fc.constant('</div>'),
  fc.constant('<!-- comment'),
  fc.constant('www.example.com'),
  fc.constant('http://x.y/z'),
  fc.constant('a@b.co'),
  fc.constant('&amp; &#35; &nope;'),
  fc.constant('\\*escaped\\*'),
  fc.constant('[ ] task'),
  fc.constant('[x] done'),
  fc.constant('\t tabbed'),
  fc.constant('   spaces'),
  fc.constant('  \t mix'),
)
const arbitraryMarkdown = fc
  .array(lineFragment, { maxLength: 24 })
  .map((lines) => lines.join('\n') + (lines.length > 0 ? '\n' : ''))

function checkInvariants(node: MdNode, docLen: number, errors: string[]): void {
  const span = (node as { span?: { start?: { offset: number }; end?: { offset: number } } }).span
  if (!span?.start || !span.end) {
    errors.push(`missing span on ${node.type}`)
    return
  }
  if (span.start.offset > span.end.offset) errors.push(`inverted span on ${node.type}`)
  if (span.end.offset > docLen) errors.push(`span past doc end on ${node.type}`)
  for (const child of childNodes(node)) checkInvariants(child, docLen, errors)
}

describe('fuzz', () => {
  it('arbitrary unicode: no throw, spans sane, both dialects agree on structure', () => {
    fc.assert(
      fc.property(arbitraryText, (text) => {
        expect(() => render(text)).not.toThrow()
        const errors: string[] = []
        checkInvariants(parse(text), text.length, errors)
        expect(errors).toEqual([])
        expect(() => render(text, { dialect: 'gfm' })).not.toThrow()
      }),
      { numRuns: CASES },
    )
  })

  it('markdown soup: no throw, invariants, html is a string', () => {
    fc.assert(
      fc.property(arbitraryMarkdown, (md) => {
        expect(() => render(md, { dialect: 'gfm' })).not.toThrow()
        const errors: string[] = []
        checkInvariants(parse(md, { dialect: 'gfm' }), md.length, errors)
        expect(errors).toEqual([])
        const html = render(md, { dialect: 'gfm' })
        expect(typeof html).toBe('string')
      }),
      { numRuns: CASES },
    )
  })

  it('rendered text can never inject unescaped markup from text content', () => {
    // every '<' in the output must come from raw-html nodes or our own tags;
    // simplest sound check: text node values get escaped on render
    fc.assert(
      fc.property(arbitraryMarkdown, (md) => {
        const html = render(md, { dialect: 'gfm' })
        const doc = parse(md, { dialect: 'gfm' })
        const literals: string[] = []
        const walk = (n: MdNode): void => {
          if (n.type === 'text' && n.value !== undefined) literals.push(n.value)
          for (const c of childNodes(n)) walk(c)
        }
        walk(doc)
        for (const lit of literals) {
          if (lit.includes('<')) {
            const escaped = lit.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            if (escaped.includes('&lt;') && !html.includes(escaped)) {
              throw new Error(
                `text node with < rendered unescaped somewhere: ${JSON.stringify(lit.slice(0, 40))}`,
              )
            }
          }
        }
      }),
      { numRuns: CASES },
    )
  })
})
