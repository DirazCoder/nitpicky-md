import { describe, expectTypeOf, it } from 'vitest'
import { expectTypeOf as _expectTypeOf } from 'expect-type'
import { parse, render, renderNode, childNodes } from '../../src/api'
import type {
  Document,
  Heading,
  Paragraph,
  Link,
  CodeBlock,
  Table,
  RuleId,
  SourceSpan,
} from '../../src/api'
import type { TableRow } from '../../src/api'
import type { MdNode } from '../../src/ast'

void _expectTypeOf

// type-level contract for the public api. a regression here fails CI the same
// way a runtime one does.

describe('public api types', () => {
  it('parse returns a Document', () => {
    expectTypeOf(parse('')).toEqualTypeOf<Document>()
    expectTypeOf(parse('', {})).toEqualTypeOf<Document>()
    expectTypeOf(parse('', { dialect: 'gfm' })).toEqualTypeOf<Document>()
    expectTypeOf(parse('', { dialect: 'commonmark' })).toEqualTypeOf<Document>()
  })

  it('render returns a string', () => {
    expectTypeOf(render('')).toEqualTypeOf<string>()
    expectTypeOf(render('', { dialect: 'gfm' })).toEqualTypeOf<string>()
  })

  it('renderNode takes any node', () => {
    expectTypeOf(renderNode).parameter(0).toEqualTypeOf<MdNode>()
    expectTypeOf(
      renderNode({ type: 'text', rule: 'text', span: null as unknown as SourceSpan, value: '' }),
    ).toEqualTypeOf<string>()
  })

  it('nodes are discriminated unions', () => {
    const doc = parse('# hi')
    const heading = doc.children[0]
    if (heading !== undefined) {
      expectTypeOf(heading.type).toEqualTypeOf<
        | 'document'
        | 'paragraph'
        | 'heading'
        | 'thematic-break'
        | 'code-block'
        | 'html-block'
        | 'blockquote'
        | 'list'
        | 'list-item'
        | 'link-reference-definition'
        | 'table'
        | 'table-row'
        | 'table-cell'
      >()
      if (heading.type === 'heading') {
        expectTypeOf(heading.depth).toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6>()
        expectTypeOf<Heading['variant']>().toEqualTypeOf<'atx' | 'setext'>()
      }
      if (heading.type === 'code-block') {
        expectTypeOf<CodeBlock['variant']>().toEqualTypeOf<'indented' | 'fenced'>()
      }
    }
  })

  it('link carries variant + optional title/label', () => {
    expectTypeOf<Link['variant']>().toEqualTypeOf<
      'inline' | 'reference' | 'collapsed' | 'shortcut'
    >()
    expectTypeOf<Link['title']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Link['label']>().toEqualTypeOf<string | undefined>()
  })

  it('table shape', () => {
    expectTypeOf<Table['header']['type']>().toEqualTypeOf<'table-row'>()
    expectTypeOf<Table['body']>().toEqualTypeOf<readonly TableRow[]>()
  })

  it('childNodes returns readonly nodes', () => {
    const doc = parse('')
    expectTypeOf(childNodes(doc)).toEqualTypeOf<readonly MdNode[]>()
  })

  it('paragraph children are inline nodes', () => {
    expectTypeOf<Paragraph['children'][number]['type']>().toMatchTypeOf<string>()
    expectTypeOf<RuleId>().toMatchTypeOf<string>()
  })
})
