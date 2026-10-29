import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse, childNodes } from '../../src/api'
import type { MdNode } from '../../src/ast'

// drafts are loosely-typed bags; this file is what makes the final cast
// honest: walk the whole AST of every spec example and assert the shape and
// position invariants the public types promise.

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/commonmark-0.31.2.json'), 'utf8'),
) as { markdown: string }[]
const gfm = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/gfm-extensions.json'), 'utf8'),
) as { markdown: string }[]

const KNOWN = new Set([
  'document',
  'paragraph',
  'heading',
  'thematic-break',
  'code-block',
  'html-block',
  'blockquote',
  'list',
  'list-item',
  'link-reference-definition',
  'table',
  'table-row',
  'table-cell',
  'text',
  'escape',
  'entity',
  'code-span',
  'emphasis',
  'strong',
  'strikethrough',
  'link',
  'image',
  'autolink',
  'raw-html',
  'soft-break',
  'hard-break',
])
const RULES = new Set([
  'document',
  'paragraph',
  'atx-heading',
  'setext-heading',
  'thematic-break',
  'indented-code',
  'fenced-code',
  'html-block',
  'blockquote',
  'list',
  'list-item',
  'link-reference-definition',
  'table',
  'table-row',
  'table-cell',
  'text',
  'escape',
  'entity',
  'code-span',
  'emphasis',
  'strong',
  'strikethrough',
  'link',
  'image',
  'autolink',
  'raw-html',
  'soft-break',
  'hard-break',
])

function checkNode(
  node: MdNode,
  docLen: number,
  parent: MdNode | undefined,
  errors: string[],
): void {
  const path = `${parent?.type ?? '?'}>${node.type}`
  if (!KNOWN.has(node.type)) errors.push(`unknown type ${node.type}`)
  if (!RULES.has((node as { rule?: string }).rule ?? '')) {
    errors.push(`unknown rule ${(node as { rule?: string }).rule} on ${path}`)
  }
  const span = (node as { span?: { start?: Posish; end?: Posish } }).span
  if (!span?.start || !span.end) {
    errors.push(`missing span on ${path}`)
    return
  }
  const { start, end } = span
  if (!(start.offset <= end.offset)) errors.push(`start > end on ${path}`)
  if (!(start.line >= 1 && start.column >= 1)) errors.push(`bad start line/col on ${path}`)
  if (!(end.offset >= 0 && end.offset <= docLen))
    errors.push(`end offset ${end.offset} out of doc on ${path}`)
  if (start.offset > 0 && start.offset >= docLen && node.type !== 'document') {
    errors.push(`start offset ${start.offset} out of doc on ${path}`)
  }
  // children stay inside the parent, in order
  let prevEnd = -1
  for (const child of childNodes(node)) {
    const cs = (child as { span?: { start?: Posish; end?: Posish } }).span
    if (!cs?.start || !cs.end) {
      errors.push(`child missing span under ${path}`)
      continue
    }
    if (cs.start.offset < start.offset - 0 || cs.end.offset > end.offset) {
      // table rows/cells intentionally live inside the table; no exceptions known
      errors.push(`child of ${path} escapes parent span`)
    }
    if (cs.start.offset < prevEnd) errors.push(`children out of order under ${path}`)
    prevEnd = cs.end.offset
    checkNode(child, docLen, node, errors)
  }
}

type Posish = { offset: number; line: number; column: number }

describe('AST shape + positions over the spec corpus', () => {
  for (const [label, cases, dialect] of [
    ['commonmark', spec, undefined],
    ['gfm', gfm, 'gfm'],
  ] as const) {
    it(`${label}: every node well-formed`, () => {
      const errors: string[] = []
      for (const ex of cases) {
        const doc = parse(ex.markdown, dialect ? { dialect } : undefined)
        checkNode(doc as unknown as MdNode, ex.markdown.length, undefined, errors)
      }
      // the first handful is plenty to debug; the count catches the rest
      expect(errors.slice(0, 5), `${errors.length} shape errors`).toEqual([])
    })
  }
})
