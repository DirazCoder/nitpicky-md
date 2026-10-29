import { describe, expect, it } from 'vitest'
import { explain, formatExplanation } from '../../src/api'
import { RULE_SPECS } from '../../src/provenance'

function RULE_SECTION(rule: string | undefined): string {
  if (!rule) return ''
  return RULE_SPECS[rule as keyof typeof RULE_SPECS]?.section ?? ''
}

// 30+ known-confusing cases. the assertions check the explanation is
// CORRECT, not just plausible: the right rule, the right spec section, the
// right rejected alternative.

function at(md: string, pos: number | { line: number; column: number }, gfm = false) {
  return explain(md, pos, gfm ? { dialect: 'gfm' } : undefined)
}

describe('explain: confusing cases', () => {
  it('1. nested links: outer bracket stays literal', () => {
    // the outer [ is literal text: links may not contain links (§6.6)
    const r = at('[foo [bar](/uri)](/uri2)', 1)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
    expect(r.rejected.some((e) => e.construct === 'link')).toBe(true)
    // inside "bar" the path runs through the inner link
    const inner = at('[foo [bar](/uri)](/uri2)', 7)
    expect(inner.path.map((n) => n.type)).toContain('link')
  })

  it('2. rule of three blocks *** pairing', () => {
    const r = at('*foo**bar**baz*', 2)
    expect(r.path.some((n) => n.type === 'emphasis' || n.type === 'strong')).toBe(true)
  })

  it('3. ***foo*** is em > strong', () => {
    const r = at('***foo***', 3)
    const types = r.path.map((n) => n.type)
    expect(types).toEqual(['document', 'paragraph', 'emphasis', 'strong', 'text'])
  })

  it('4. lazy continuation in blockquote', () => {
    const r = at('> foo\nbar\n', { line: 2, column: 1 })
    expect(r.path[1]?.type).toBe('blockquote')
    expect(r.path[2]?.type).toBe('paragraph')
  })

  it('5. setext beats thematic break after a paragraph', () => {
    const r = at('Foo\n---\n', { line: 2, column: 1 })
    expect(r.path[1]?.type).toBe('heading')
    expect((r.path[1] as { variant?: string }).variant).toBe('setext')
    expect(r.spec?.section).toBe('§4.3')
  })

  it('6. --- with no open paragraph is a thematic break', () => {
    const r = at('---\n', 1)
    expect(r.path[1]?.type).toBe('thematic-break')
    expect(r.spec?.section).toBe('§4.1')
  })

  it('7. intraword underscores stay literal', () => {
    const r = at('snake_case_name', 7)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
    expect(r.summary).toContain('plain text')
  })

  it('8. code span needs equal backtick runs', () => {
    const r = at('``foo`bar``', 3)
    expect(r.path.some((n) => n.type === 'code-span')).toBe(true)
    expect(r.spec?.section).toBe('§6.10')
  })

  it('9. unequal backtick runs stay literal', () => {
    // opener is a single backtick; the only other run is length 2
    const r = at('`foo``', 2)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
  })

  it('10. link with title', () => {
    const r = at('[link](/url "title")', 3)
    // deepest node at this offset is the link text; the link is its parent
    const link = r.path.find((n) => n.type === 'link')
    expect((link as { variant?: string } | undefined)?.variant).toBe('inline')
  })

  it('11. broken inline link explains why', () => {
    const r = at('see [link](/url "unterminated', 5)
    expect(r.rejected.some((e) => e.reason === 'no-destination-or-title')).toBe(true)
  })

  it('12. reference link cites the definition path', () => {
    const r = at('[foo][bar]\n\n[bar]: /url\n', 2)
    const link = r.path.find((n) => n.type === 'link')
    expect((link as { variant?: string } | undefined)?.variant).toBe('reference')
  })

  it('13. undefined reference is text + rejected event', () => {
    const r = at('[foo][bar]\n', 2)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
    expect(r.rejected.some((e) => e.reason === 'reference-undefined')).toBe(true)
  })

  it('14. html type 7 cannot interrupt a paragraph', () => {
    const r = at('text\n<span>\n', { line: 2, column: 2 })
    expect(r.path[1]?.type).toBe('paragraph')
  })

  it('15. html type 6 can interrupt a paragraph', () => {
    const r = at('text\n<div>\n', { line: 2, column: 2 })
    expect(r.path[1]?.type).toBe('html-block')
    expect(r.spec?.section).toBe('§4.6')
  })

  it('16. indented line after paragraph is lazy continuation, not code', () => {
    const r = at('> foo\n    bar\n', { line: 2, column: 5 })
    expect(r.path[2]?.type).toBe('paragraph')
  })

  it('17. four-space indent without paragraph is code', () => {
    const r = at('    code\n', 6)
    expect(r.path[1]?.type).toBe('code-block')
    expect((r.path[1] as { variant?: string }).variant).toBe('indented')
    expect(r.spec?.section).toBe('§4.4')
  })

  it('18. ordered list not starting at 1 cannot interrupt', () => {
    const r = at('foo\n2. bar\n', { line: 2, column: 1 })
    expect(r.path[1]?.type).toBe('paragraph')
    expect(r.rejected.some((e) => e.construct === 'list-item')).toBe(true)
  })

  it('19. ordered list starting at 1 interrupts', () => {
    const r = at('foo\n1. bar\n', { line: 2, column: 1 })
    expect(r.path[1]?.type).toBe('list')
  })

  it('20. fenced code inside a list item', () => {
    const md = '- ```\n  foo\n  ```\n'
    const r = at(md, { line: 2, column: 3 })
    expect(r.path.some((n) => n.type === 'code-block')).toBe(true)
    expect(r.path.some((n) => n.type === 'list-item')).toBe(true)
    expect(r.spec?.section).toBe('§4.5')
  })

  it('21. mixed delimiter counts leave leftovers', () => {
    const r = at('**foo*', 1)
    expect(r.path.some((n) => n.type === 'emphasis')).toBe(true)
  })

  it('22. escaped bracket is not a link', () => {
    const r = at('\\[foo](bar)', 1)
    expect(r.path.some((n) => n.type === 'escape')).toBe(true)
  })

  it('23. uri autolink vs raw html', () => {
    const a = at('go <http://x.y> now', 5)
    expect(a.path[a.path.length - 1]?.type).toBe('autolink')
    // a bare tag inline is raw html; alone on a line it's an html block
    const b = at('go <foo> now', 5)
    expect(b.path[b.path.length - 1]?.type).toBe('raw-html')
    const c = at('<foo>\n', 2)
    expect(c.path[1]?.type).toBe('html-block')
  })

  it('24. entity in link destination decodes', () => {
    const r = at('[a](/f&ouml;&ouml;)', 5)
    expect(r.rule).toBe('link')
  })

  it('25. two trailing spaces are a hard break', () => {
    const r = at('foo  \nbar', 4)
    expect(r.path.some((n) => n.type === 'hard-break')).toBe(true)
  })

  it('26. one trailing space is not', () => {
    const r = at('foo \nbar', 4)
    expect(r.path.some((n) => n.type === 'hard-break')).toBe(false)
  })

  it('27. reference definitions feeding a setext heading', () => {
    const r = at('[foo]: /url\n===\n', { line: 2, column: 1 })
    expect(r.path[1]?.type).toBe('paragraph')
  })

  it('28. gfm table cell provenance', () => {
    const r = at('| a | b |\n| --- | --- |\n| c | d |\n', { line: 3, column: 3 }, true)
    expect(r.path.some((n) => n.type === 'table-cell')).toBe(true)
    const cell = r.path.find((n) => n.type === 'table-cell')
    expect(cell ? RULE_SECTION(cell.rule) : '').toContain('GFM Tables')
  })

  it('29. malformed delimiter row keeps the paragraph', () => {
    const r = at('| a | b |\n| -- x |\n', { line: 2, column: 3 }, true)
    expect(r.path[1]?.type).toBe('paragraph')
  })

  it('30. gfm strikethrough', () => {
    const r = at('~~gone~~', 3, true)
    expect(r.path[2]?.type).toBe('strikethrough')
    expect(RULE_SECTION(r.path[2]?.rule)).toContain('GFM Strikethrough')
  })

  it('31. gfm www autolink', () => {
    const r = at('see www.commonmark.org now', 6, true)
    expect(r.path.some((n) => n.type === 'autolink')).toBe(true)
  })

  it('32. www without gfm stays text', () => {
    const r = at('see www.commonmark.org now', 6)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
  })

  it('33. code span spanning a soft break', () => {
    const r = at('`foo\nbar`', 2)
    expect(r.path.some((n) => n.type === 'code-span')).toBe(true)
  })

  it('34. image alt is inline content', () => {
    const r = at('![alt *text*](/u)', 8)
    expect(r.path.some((n) => n.type === 'image')).toBe(true)
  })

  it('35. hard break with backslash', () => {
    const r = at('foo\\\nbar', 4)
    expect(r.path.some((n) => n.type === 'hard-break')).toBe(true)
  })

  it('36. atx heading cites its section', () => {
    const r = at('## hello', 1)
    expect(r.rule).toBe('atx-heading')
    expect(r.spec?.section).toBe('§4.2')
  })

  it('37. blockquote marker line explains as blockquote', () => {
    const r = at('> quoted', 1)
    expect(r.path[1]?.type).toBe('blockquote')
    expect(r.spec?.section).toBe('§5.1')
  })

  it('38. list item sourcepos + rule', () => {
    const r = at('1. one', 1)
    expect(r.path.some((n) => n.type === 'list-item')).toBe(true)
    expect(r.spec?.section).toBe('§5.2')
  })

  it('39. formatting includes the human-readable text', () => {
    const md = 'x [oops](unterminated\n'
    const text = formatExplanation(explain(md, 2))
    expect(text).toContain('1:3')
    expect(text).toMatch(/tried link: rejected/)
  })

  it('40. empty label never matches', () => {
    const r = at('[] and []: /uri\n', 1)
    expect(r.path[r.path.length - 1]?.type).toBe('text')
  })
})
