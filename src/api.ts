import type { DocumentNode as Document, MdNode, Mutable } from './ast'
import { parseBlocks, type RefDefinition } from './block/parser'
import { InlineRun } from './inline/parser'
import { renderHtml } from './html'
import { normalizeSource, positionAt } from './normalize'
import { createRecorder } from './trace'
import { bindRenderer } from './compare'
import { distillDiagnostics } from './diagnostics'
import type { Diagnostic } from './diagnostics'
import { resolvePosition, explainAt } from './explain'
import type { Explanation } from './explain'
import type { TraceEvent, NearMiss } from './trace'

// public api. parse() is the zero-cost-when-untraced path; analyze() and
// explain() turn the same parse into diagnostics and provenance.

export interface ParseOptions {
  /** `commonmark` (default) or `gfm` */
  readonly dialect?: 'commonmark' | 'gfm'
  /** record the decision trace; off by default */
  readonly trace?: boolean
}

export interface ParseInternals {
  readonly refMap: Map<string, RefDefinition>
  readonly nearMisses: NearMiss[]
  /** empty unless parse ran with {trace: true} */
  readonly trace: readonly TraceEvent[]
}

bindRenderer(
  (md, dialect) => render(md, { dialect }),
  (md, dialect) => parse(md, { dialect }) as unknown as import('./ast').MdNode,
)

export function parse(md: string, options?: ParseOptions): Document {
  return parseFull(md, options).document
}

export function render(md: string, options?: ParseOptions): string {
  return renderHtml(parse(md, options) as unknown as Mutable<MdNode>)
}

export interface AnalyzeResult {
  readonly document: Document
  readonly diagnostics: readonly Diagnostic[]
}

export function analyze(md: string, options?: ParseOptions): AnalyzeResult {
  const { document, internals } = parseFull(md, options)
  return { document, diagnostics: distillDiagnostics(internals.nearMisses, md) }
}

export interface ExplainOptions extends ParseOptions {
  /** force a trace even though explain runs one anyway (no-op, symmetry) */
  readonly trace?: boolean
}

export function explain(
  md: string,
  position: number | { line: number; column: number },
  options?: ExplainOptions,
): Explanation {
  const { document, internals } = parseFull(md, { ...options, trace: true })
  const offset = resolvePosition(md, position)
  const pos = positionAt(normalizeSource(md), offset)
  return explainAt(document, internals.trace, offset, pos)
}

export function renderNode(node: MdNode): string {
  return renderHtml(node as unknown as Mutable<MdNode>)
}

/** full parse incl. the internals the diagnostics/explain layers need */
export function parseFull(
  md: string,
  options?: ParseOptions,
): { document: Document; internals: ParseInternals } {
  const dialect = options?.dialect ?? 'commonmark'
  const gfm = dialect === 'gfm'
  const recorder = options?.trace === true ? createRecorder() : undefined
  const doc = normalizeSource(md)
  const blocks = parseBlocks(doc, gfm, recorder)
  runInlines(
    doc,
    blocks.root as unknown as DraftNode,
    blocks.refMap,
    gfm,
    blocks.nearMisses,
    recorder,
  )
  return {
    document: blocks.root as unknown as Document,
    internals: {
      refMap: blocks.refMap,
      nearMisses: blocks.nearMisses,
      trace: recorder ? recorder.events : [],
    },
  }
}

// -- inline phase wiring --------------------------------------------------------

type DraftNode = {
  type: string
  rule: string
  span: { start: unknown; end: unknown }
  children?: DraftNode[]
  lines?: string[] | undefined
  lineOffsets?: number[] | undefined
  lineNos?: number[] | undefined
  cells?: string[] | undefined
  cellStarts?: number[] | undefined
  lineOffset?: number | undefined
  lineNo?: number | undefined
  lineLen?: number | undefined
  header?: DraftNode | undefined
  body?: DraftNode[] | undefined
  [k: string]: unknown
}

function runInlines(
  doc: ReturnType<typeof normalizeSource>,
  root: DraftNode,
  refs: Map<string, RefDefinition>,
  gfm: boolean,
  nearMisses: NearMiss[],
  trace?: import('./trace').TraceRecorder,
): void {
  const posAtDoc = (offset: number): { offset: number; line: number; column: number } =>
    positionAt(doc, offset)
  // iterative walk; deep nesting is a fuzz fixture, not a theory
  const stack: DraftNode[] = [root]
  while (stack.length > 0) {
    const d = stack.pop()
    if (!d) continue
    if (d.type === 'paragraph' || d.type === 'heading') {
      const lines = d.lines ?? []
      if (lines.length > 0) {
        const lineMap: { start: number; offset: number; lineNo: number; docLen: number }[] = []
        let at = 0
        for (let i = 0; i < lines.length; i++) {
          const off = d.lineOffsets?.[i] ?? 0
          const lineNo = d.lineNos?.[i] ?? 1
          const docLine = doc.lines[lineNo - 1] ?? ''
          const lineStart = doc.lineStarts[lineNo - 1] ?? 0
          lineMap.push({
            start: at,
            offset: off,
            lineNo,
            docLen: Math.max(0, docLine.length - (off - lineStart)),
          })
          at += (lines[i] ?? '').length + 1
        }
        const content = lines.join('\n')
        const run = new InlineRun(doc, content, lineMap, refs, gfm, nearMisses, trace)
        d.children = run.parse() as unknown as DraftNode[]
      }
      d.lines = undefined
      d.lineOffsets = undefined
      d.lineNos = undefined
    } else if (d.type === 'table-row') {
      const cells = d.cells ?? []
      const starts = d.cellStarts ?? cells.map(() => 0)
      const base = d.lineOffset ?? 0
      const lineNo = d.lineNo ?? 1
      const docLine = doc.lines[lineNo - 1] ?? ''
      const lineStart = doc.lineStarts[lineNo - 1] ?? 0
      const kids: DraftNode[] = []
      for (let i = 0; i < cells.length; i++) {
        const rawCell = cells[i] ?? ''
        const cell = rawCell.trim()
        const cellStart = starts[i] ?? 0
        // leading trim only moves the offset; the trailing trim doesn't
        const lead = rawCell.length - rawCell.trimStart().length
        const cellOffset = base + cellStart + lead
        const lineMap = [
          {
            start: 0,
            offset: cellOffset,
            lineNo,
            docLen: Math.max(0, docLine.length - (cellOffset - lineStart)),
          },
        ]
        const run = new InlineRun(doc, cell, lineMap, refs, gfm, nearMisses, trace)
        const cellNode: DraftNode = {
          type: 'table-cell',
          rule: 'table-cell',
          span: {
            start: posAtDoc(cellOffset),
            end: posAtDoc(cellOffset + cell.length),
          },
          children: run.parse() as unknown as DraftNode[],
        }
        kids.push(cellNode)
      }
      d.children = kids
      d.cells = undefined
      d.cellStarts = undefined
    } else {
      const kids: DraftNode[] = [
        ...(d.children ?? []),
        ...((d as { body?: DraftNode[] | undefined }).body ?? []),
      ]
      for (const k of kids) stack.push(k)
      if (d.header) stack.push(d.header)
    }
  }
}

export { childNodes } from './ast'
export type { Diagnostic, Fix } from './diagnostics'
export { compare, commonmarkProfile, gfmProfile } from './compare'
export type { Engine, DivergenceReport, Divergence } from './compare'
export type { Explanation, ExplainResult, ExplainPosition } from './explain'
export { formatExplanation } from './explain'
export type { Alignment, RuleId } from './ast'
export type {
  DocumentNode as Document,
  ParagraphNode as Paragraph,
  HeadingNode as Heading,
  ThematicBreakNode as ThematicBreak,
  CodeBlockNode as CodeBlock,
  HtmlBlockNode as HtmlBlock,
  BlockquoteNode as Blockquote,
  ListNode as List,
  ListItemNode as ListItem,
  LinkReferenceDefinitionNode as LinkReferenceDefinition,
  TableNode as Table,
  TableRowNode as TableRow,
  TableCellNode as TableCell,
  TextNode as Text,
  EscapeNode as Escape,
  EntityNode as Entity,
  CodeSpanNode as CodeSpan,
  EmphasisNode as Emphasis,
  StrongNode as Strong,
  StrikethroughNode as Strikethrough,
  LinkNode as Link,
  ImageNode as Image,
  AutolinkNode as Autolink,
  RawHtmlNode as RawHtml,
  SoftBreakNode as SoftBreak,
  HardBreakNode as HardBreak,
  SourceSpan,
  Position,
} from './ast'
