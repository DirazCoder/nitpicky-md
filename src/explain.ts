import type { DocumentNode as Document, MdNode } from './ast'
import { childNodes } from './ast'
import type { TraceEvent } from './trace'
import { RULE_SPECS, reasonNote } from './provenance'

// explain(md, position): why is the text at this position what it is?
// = the deepest node covering the position, the rule + spec section that
// produced it, and the alternatives the parser rejected on the way there.

export interface ExplainPosition {
  readonly offset: number
  readonly line: number
  readonly column: number
}

export interface ExplainResult {
  readonly position: ExplainPosition
  /** deepest node covering the position, as a path from the document */
  readonly path: readonly MdNode[]
  readonly rule: string
  readonly spec: { section: string; title: string; url: string } | undefined
  /** accepted decisions that touched this node's span */
  readonly accepted: readonly TraceEvent[]
  /** rejected attempts inside or adjacent to the position, most relevant first */
  readonly rejected: readonly TraceEvent[]
  /** human-readable summary, the "not a link: closing bracket found, but no destination follows" bit */
  readonly summary: string
}

/** position as a doc offset; {line, column} variants resolve via lines */
export function resolvePosition(
  text: string,
  pos: number | { line: number; column: number },
): number {
  if (typeof pos === 'number') return pos
  const lines = text.split('\n')
  const line = lines[pos.line - 1] ?? ''
  let offset = 0
  for (let i = 0; i < pos.line - 1; i++) offset += (lines[i] ?? '').length + 1
  // column counts code points, not utf-16 units; walk them
  let units = 0
  let cp = 0
  while (cp < pos.column - 1 && units < line.length) {
    const c = line.codePointAt(units)
    if (c === undefined) break
    units += c > 0xffff ? 2 : 1
    cp++
  }
  return offset + units
}

export function explainAt(
  document: Document,
  trace: readonly TraceEvent[],
  offset: number,
  position: ExplainPosition,
): ExplainResult {
  // walk to the deepest node containing the offset; iterative, deep trees
  const path: MdNode[] = []
  let current: MdNode = document
  path.push(current)
  for (;;) {
    let descended = false
    for (const child of childNodes(current)) {
      const s = child.span
      if (s.start.offset <= offset && offset < s.end.offset) {
        path.push(child)
        current = child
        descended = true
        break
      }
    }
    if (!descended) break
  }

  const node = path[path.length - 1] ?? document
  const rule = (node as { rule?: string }).rule ?? node.type
  const spec = RULE_SPECS[rule as keyof typeof RULE_SPECS]

  // events whose span touches the position; accepted ones for this node's
  // construct, rejected ones at or just before the position
  const spanStart = node.span.start.offset
  const spanEnd = node.span.end.offset
  // rejections that explain this node can sit after it (the `](...)` that
  // failed is past the `[` text node), so window on the enclosing block
  const block = [...path].reverse().find((n) => n.type !== 'text') ?? node
  const blockStart = block.span.start.offset
  const blockEnd = block.span.end.offset
  const accepted: TraceEvent[] = []
  const rejected: TraceEvent[] = []
  for (const e of trace) {
    if (e.start === undefined) continue
    if (e.verdict === 'accepted') {
      if (e.construct === rule || (e.start >= spanStart && e.start < spanEnd)) accepted.push(e)
    } else if (e.start >= blockStart && e.start <= blockEnd) {
      rejected.push(e)
    }
  }
  // nearest rejections first, and inline-phase ones ahead of the
  // every-line block-start noise (atx/fence/html/thematic) when we're
  // explaining inline content
  const nodeIsInline = path.length > 1 && path[path.length - 2]?.type === 'paragraph'
  rejected.sort((a, b) => {
    if (nodeIsInline) {
      const ai = a.phase === 'inline' ? 0 : 1
      const bi = b.phase === 'inline' ? 0 : 1
      if (ai !== bi) return ai - bi
    }
    return Math.abs((a.start ?? 0) - offset) - Math.abs((b.start ?? 0) - offset)
  })

  const summary = buildSummary(node, path, rejected, spec)

  return { position, path, rule, spec, accepted, rejected, summary }
}

function buildSummary(
  node: MdNode,
  path: readonly MdNode[],
  rejected: readonly TraceEvent[],
  spec: { section: string; title: string; url: string } | undefined,
): string {
  const parent = path[path.length - 2]
  const bits: string[] = []
  const value = (node as { value?: string }).value
  switch (node.type) {
    case 'text':
      bits.push(
        parent?.type === 'paragraph' || parent?.type === 'heading'
          ? 'plain text'
          : `plain text inside a ${parent?.type ?? 'document'}`,
      )
      break
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
      bits.push(`${node.type} formatting`)
      break
    case 'code-span':
      bits.push('code span')
      break
    case 'link':
    case 'image': {
      const v = node as { variant?: string }
      bits.push(`${node.type} (${v.variant ?? 'inline'} form)`)
      break
    }
    case 'autolink':
      bits.push('autolink')
      break
    case 'raw-html':
      bits.push('raw html passed through verbatim')
      break
    case 'escape':
      bits.push(`escaped character (renders literally as ${JSON.stringify(value ?? '')})`)
      break
    case 'entity':
      bits.push('character reference (decoded)')
      break
    case 'soft-break':
      bits.push('soft line break (renders as a newline)')
      break
    case 'hard-break':
      bits.push('hard line break (renders as <br />)')
      break
    default:
      bits.push(node.type.replace(/-/g, ' '))
  }
  if (spec) bits.push(`from ${spec.section} ${spec.title}`)
  // the most informative rejection gets quoted
  const r = rejected.find((e) => e.reason !== undefined)
  if (r) {
    const note = reasonNote(r.reason)
    bits.push(`not ${r.construct}: ${note ?? r.reason ?? 'it did not match'}`)
  }
  return bits.join('; ')
}

export function formatExplanation(result: ExplainResult): string {
  const lines: string[] = []
  const p = result.position
  lines.push(`${p.line}:${p.column} (offset ${p.offset})`)
  lines.push(`  ${result.summary}`)
  if (result.path.length > 1) {
    lines.push(`  path: ${result.path.map((n) => n.type).join(' > ')}`)
  }
  if (result.spec) {
    lines.push(`  rule: ${result.rule} (${result.spec.section}, ${result.spec.url})`)
  }
  for (const e of result.rejected.slice(0, 5)) {
    const note = reasonNote(e.reason)
    // spec refs on rejections are the whole point of provenance -- a rejected
    // atx-heading attempt should point at §4.2, not just say "nope"
    const ref = e.spec !== undefined ? ` (${e.spec})` : ''
    lines.push(`  tried ${e.construct}: rejected${note ? ` -- ${note}` : ''}${ref}`)
  }
  return lines.join('\n')
}

export type { ExplainResult as Explanation }
