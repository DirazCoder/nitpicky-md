import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFull } from '../../src/api'
import type { MdNode } from '../../src/ast'
import { childNodes } from '../../src/api'

// the gate for the whole trace feature: turning it on must not change the
// parse. iterative fingerprint (no recursive deep-equal -- the fuzz corpus
// has 100k-deep trees and vitest's equals would rather die than flatten).

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/commonmark-0.31.2.json'), 'utf8'),
) as { markdown: string }[]
const gfm = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/gfm-extensions.json'), 'utf8'),
) as { markdown: string }[]

/** stable structural fingerprint; catches any node/field divergence */
function fingerprint(root: MdNode): string {
  const out: string[] = []
  const walk = (node: MdNode): void => {
    const bits = [node.type, (node as { rule?: string }).rule ?? '']
    const span = (node as { span?: { start?: { offset: number }; end?: { offset: number } } }).span
    bits.push(String(span?.start?.offset ?? -1), String(span?.end?.offset ?? -1))
    if (
      node.type === 'text' ||
      node.type === 'code-span' ||
      node.type === 'escape' ||
      node.type === 'entity' ||
      node.type === 'raw-html' ||
      node.type === 'autolink'
    ) {
      bits.push(JSON.stringify((node as { value?: string }).value))
    }
    if (node.type === 'link' || node.type === 'image') {
      const l = node as { destination?: string; title?: string; variant?: string; label?: string }
      bits.push(String(l.destination), String(l.title), String(l.variant), String(l.label))
    }
    if (node.type === 'heading')
      bits.push(
        String((node as { depth?: number }).depth),
        String((node as { variant?: string }).variant),
      )
    if (node.type === 'list') {
      const l = node as {
        ordered?: boolean
        tight?: boolean
        start?: number
        marker?: string
        delimiter?: string
      }
      bits.push(
        String(l.ordered),
        String(l.tight),
        String(l.start),
        String(l.marker),
        String(l.delimiter),
      )
    }
    if (node.type === 'list-item') bits.push(String((node as { checked?: boolean }).checked))
    if (node.type === 'table')
      bits.push(JSON.stringify((node as { alignments?: readonly string[] }).alignments))
    out.push(bits.join('|'))
    for (const child of childNodes(node)) walk(child)
  }
  walk(root)
  return out.join('\n')
}

describe('tracing never changes the parse result', () => {
  it('commonmark corpus: identical ASTs with trace on and off', () => {
    let mismatches = 0
    const first: string[] = []
    for (const ex of spec) {
      const off = fingerprint(parseFull(ex.markdown).document)
      const on = fingerprint(parseFull(ex.markdown, { trace: true }).document)
      if (off !== on) {
        mismatches++
        if (first.length < 3) first.push(JSON.stringify(ex.markdown.slice(0, 60)))
      }
    }
    expect(mismatches, `trace changed ${mismatches} parses: ${first.join(' ')}`).toBe(0)
  })

  it('gfm corpus: identical ASTs with trace on and off', () => {
    for (const ex of gfm) {
      const off = fingerprint(parseFull(ex.markdown, { dialect: 'gfm' }).document)
      const on = fingerprint(parseFull(ex.markdown, { dialect: 'gfm', trace: true }).document)
      expect(on).toBe(off)
    }
  })

  it('trace events actually come out', () => {
    const { internals } = parseFull('*em* [ok](/url) [undef][ref]', { trace: true })
    const constructs = internals.trace.map((e) => `${e.construct}:${e.verdict}`)
    expect(constructs).toContain('emphasis:accepted')
    expect(constructs).toContain('link:accepted')
    expect(constructs).toContain('link:rejected')
    const rejected = internals.trace.find((e) => e.construct === 'link' && e.verdict === 'rejected')
    expect(rejected?.reason).toBe('reference-undefined')
    expect(internals.trace.length).toBeGreaterThan(0)
  })

  it('trace records spec citations', () => {
    const { internals } = parseFull('# hi', { trace: true })
    const atx = internals.trace.find(
      (e) => e.construct === 'atx-heading' && e.verdict === 'accepted',
    )
    expect(atx?.spec).toBe('CommonMark 0.31.2 §4.2')
  })
})
