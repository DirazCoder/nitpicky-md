import type { DocumentNode, Mutable, SourceSpan } from '../ast'
import type { SourceDoc } from '../normalize'
import { positionAt } from '../normalize'
import { htmlBlockEnd, htmlBlockStart, type HtmlBlockType } from './html-blocks'
import {
  scanAtxHeading,
  scanFence,
  scanListMarker,
  scanSetextUnderline,
  scanThematicBreak,
  type ListMarkerMatch,
} from './starts'
import { scanLinkDestination, scanLinkLabel, scanLinkTitle, normalizeLabel } from '../inline/links'
import { scanHtmlTag } from '../inline/raw-html'
import { decodeEntityAt } from '../inline/entities'
import { isAsciiPunctuation } from '../unicode'
import type { TraceRecorder, NearMiss } from '../trace'

// block phase: one pass over the lines, cmark-style container matching with a
// tab-aware (offset, column) cursor. drafts are loosely-typed bags; their
// conformance to the real AST is enforced by tests/unit/shape.spec.ts, which
// is what makes the cast at the bottom honest.

export interface RefDefinition {
  normalizedLabel: string
  destination: string
  title: string | undefined
  span: SourceSpan
}

export interface BlockPhaseResult {
  root: Mutable<DocumentNode>
  refMap: Map<string, RefDefinition>
  nearMisses: NearMiss[]
}

interface Draft {
  type: string
  rule: string
  span: { start: Pos; end: Pos }
  children: Draft[]
  lastLineBlank: boolean
  lastLineChecked: boolean
  startLine: number
  lines?: string[] | undefined
  lineOffsets?: number[] | undefined
  lineNos?: number[] | undefined
  fenceChar?: '`' | '~' | undefined
  fenceLength?: number | undefined
  fenceColumn?: number | undefined
  infoRaw?: string | undefined
  htmlType?: HtmlBlockType | undefined
  ordered?: boolean | undefined
  marker?: '-' | '+' | '*' | undefined
  delimiter?: '.' | ')' | undefined
  startNumber?: number | undefined
  tight?: boolean | undefined
  contentCol?: number | undefined
  checked?: boolean | undefined
  taskMarker?: SourceSpan | undefined
  depth?: number | undefined
  variant?: string | undefined
  alignments?: string[] | undefined
  header?: Draft | undefined
  body?: Draft[] | undefined
  cells?: string[] | undefined
  literal?: string | undefined
  info?: string | undefined
  [k: string]: unknown
}

type Pos = { offset: number; line: number; column: number }

const CODE_INDENT = 4

class BlockPhase {
  private readonly root: Draft
  private readonly stack: Draft[] = []
  private readonly refMap = new Map<string, RefDefinition>()
  private readonly nearMisses: NearMiss[] = []
  private line = ''
  private lineNo = 0
  private lineStart = 0
  private offset = 0
  private column = 0
  private partialTab = false
  private blank = false
  private indent = 0
  private nextNonspace = 0
  private nextNonspaceColumn = 0
  /** shared end-of-line position object so ancestor end updates stay cheap */
  private lineEndPos: Pos | null = null
  /** a container prefix or closing fence was consumed this line */
  private lineHadMarker = false

  /** near-miss sink; created once so trace-off allocates nothing per line */
  private readonly noteNearMiss = (nm: NearMiss): void => {
    this.nearMisses.push(nm)
  }

  /** record a construct attempt; free when not tracing */
  private tried(construct: string, accepted: boolean, reason?: string, spec?: string): void {
    if (!this.trace) return
    const event: {
      construct: string
      phase: 'block'
      verdict: 'accepted' | 'rejected'
      start: number
      reason?: string
      spec?: string
    } = {
      construct,
      phase: 'block',
      verdict: accepted ? 'accepted' : 'rejected',
      start: this.lineStart + this.nextNonspace,
    }
    if (reason !== undefined) event.reason = reason
    if (spec !== undefined) event.spec = spec
    this.trace.push(event)
  }

  private readonly trace: TraceRecorder | undefined
  private readonly gfm: boolean

  constructor(
    private doc: SourceDoc,
    gfm: boolean,
    trace?: TraceRecorder,
  ) {
    this.gfm = gfm
    this.trace = trace
    this.root = this.draft('document', 'document', 0)
    this.stack.push(this.root)
  }

  run(): BlockPhaseResult {
    const lastIdx = this.doc.lines.length - 1
    for (let i = 0; i < this.doc.lines.length; i++) {
      // "a\n" splits into ["a", ""] -- that last "" is not a line (cmark agrees)
      if (i === lastIdx && (this.doc.lines[i] ?? '') === '' && this.doc.text.endsWith('\n')) break
      this.incorporate(i)
    }
    this.closeTo(0)
    // closeTo never finalizes the root itself; the document ends at the text end
    this.root.span.end = positionAt(this.doc, this.doc.text.length)
    return {
      root: this.root as unknown as Mutable<DocumentNode>,
      refMap: this.refMap,
      nearMisses: this.nearMisses,
    }
  }

  // -- cursor helpers ------------------------------------------------------

  private findNextNonspace(): void {
    let i = this.offset
    let cols = 0
    while (i < this.line.length) {
      const ch = this.line[i] ?? ''
      if (ch === ' ') {
        cols++
        i++
      } else if (ch === '\t') {
        cols += 4 - ((this.column + cols) % 4)
        i++
      } else break
    }
    this.blank = i >= this.line.length
    this.nextNonspace = i
    this.nextNonspaceColumn = this.column + cols
    this.indent = this.nextNonspaceColumn - this.column
  }

  /** advance exactly to `target` column, splitting a tab when it straddles */
  private advanceToColumn(target: number): void {
    while (this.column < target && this.offset < this.line.length) {
      const ch = this.line[this.offset] ?? ''
      if (ch === '\t') {
        const nextStop = this.column + (4 - (this.column % 4))
        if (nextStop <= target) {
          this.column = nextStop
          this.offset++
        } else {
          this.partialTab = true
          this.column = target
          return
        }
      } else {
        this.column++
        this.offset++
      }
    }
    if (this.column > target) this.column = target
  }

  /** rest of the line; a split tab materializes its remainder as spaces */
  private restOfLine(): { text: string; offset: number } {
    if (this.partialTab && this.line[this.offset] === '\t') {
      const remainder = 4 - (this.column % 4)
      this.partialTab = false
      return { text: ' '.repeat(remainder) + this.line.slice(this.offset + 1), offset: this.offset }
    }
    this.partialTab = false
    return { text: this.line.slice(this.offset), offset: this.offset }
  }

  private at(i: number): string {
    return this.line[i] ?? ''
  }

  // -- draft plumbing -----------------------------------------------------

  private draft(type: string, rule: string, offsetInLine: number): Draft {
    const pos = positionAt(this.doc, this.lineStart + Math.min(offsetInLine, this.line.length))
    return {
      type,
      rule,
      span: { start: pos, end: pos },
      children: [],
      lastLineBlank: false,
      lastLineChecked: false,
      startLine: this.lineNo,
    }
  }

  private top(): Draft {
    const t = this.stack[this.stack.length - 1]
    if (!t) throw new Error('block stack underflow')
    return t
  }

  /** pop the top block and finalize it (bare pops lose code/html content) */
  private closeTop(): void {
    const d = this.stack.pop()
    if (d) this.finalize(d, this.top())
  }

  private closeTo(idx: number): void {
    while (this.stack.length > idx + 1) {
      const d = this.stack.pop()
      if (!d) break
      this.finalize(d, this.stack[this.stack.length - 1])
    }
  }

  private canContain(d: Draft, child: string): boolean {
    switch (d.type) {
      case 'document':
      case 'blockquote':
      case 'list-item':
        return child !== 'list-item'
      case 'list':
        return child === 'list-item'
      default:
        return false
    }
  }

  /** attach `d` under the nearest open block that can contain it */
  private attach(d: Draft): void {
    while (!this.canContain(this.top(), d.type)) {
      const closed = this.stack.pop()
      if (!closed) throw new Error('attach: stack emptied')
      this.finalize(closed, this.top())
    }
    this.top().children.push(d)
    this.stack.push(d)
  }

  private endPos(): Pos {
    if (!this.lineEndPos) this.lineEndPos = positionAt(this.doc, this.lineStart + this.line.length)
    return this.lineEndPos
  }

  private setEnd(d: Draft): void {
    if (d.span.end.offset < this.endPos().offset) d.span.end = this.endPos()
  }

  private extendAncestors(): void {
    for (const d of this.stack) this.setEnd(d)
  }

  // -- the main event -----------------------------------------------------

  private incorporate(lineIdx: number): void {
    this.line = this.doc.lines[lineIdx] ?? ''
    this.lineNo = lineIdx + 1
    this.lineStart = this.doc.lineStarts[lineIdx] ?? 0
    this.offset = 0
    this.column = 0
    this.partialTab = false
    this.lineEndPos = null
    this.findNextNonspace()

    // phase 1: match open containers, refreshing the cursor as prefixes consume
    let matched = 0
    this.lineHadMarker = false
    for (let i = 1; i < this.stack.length; i++) {
      const d = this.stack[i]
      if (!d || !this.checkContinue(d)) break
      matched = i
      this.findNextNonspace()
    }
    const allMatched = matched === this.stack.length - 1
    const tip = this.top()

    // phase 2: open leaves that swallow the line whole. blank lines are
    // content for fenced/indented code and html types 1-5; html 6/7 and
    // tables end at blanks (mark first, then close, bcz the chain anchor
    // is the deepest open block -- see markBlankChain)
    if (allMatched) {
      if (tip.type === 'code-block' && tip.fenceChar !== undefined) {
        this.fencedLine(tip)
        return
      }
      if (tip.type === 'code-block') {
        // indented code: checkContinue advanced past 4 columns
        const rest = this.restOfLine()
        this.pushLine(tip, rest)
        this.setEnd(tip)
        this.extendAncestors()
        return
      }
      if (tip.type === 'html-block') {
        if (this.blank && (tip.htmlType === 6 || tip.htmlType === 7)) {
          this.closeTop()
          return
        }
        this.htmlLine(tip)
        return
      }
      if (!this.blank && this.gfm && tip.type === 'table') {
        if (this.wouldStartBlock()) {
          // another block-level element starts here: the table ends and the
          // starts machinery below takes the line
          this.closeTop()
        } else {
          this.tableRowLine(tip)
          return
        }
      }
      if (this.blank && this.gfm && tip.type === 'table') {
        this.closeTop()
        return
      }
    }

    // a setext underline can't turn a lazily continued paragraph into a
    // heading (§4.3), but it can still join it as plain text
    const lazyPossible = !allMatched && !this.blank && tip.type === 'paragraph'

    if (this.blank) {
      // close first: the paragraph dying on this blank must not have its span
      // extended by it, or the loose-list line-gap check goes blind
      this.closeTo(matched)
      if (this.lineHadMarker) this.extendAncestors()
      const t = this.top()
      if (t.type === 'html-block' && (t.htmlType === 6 || t.htmlType === 7)) {
        this.closeTo(this.stack.length - 2)
      }
      return
    }

    // phase 3: new block starts. `base` is the deepest matched container;
    // container starts we make ourselves advance it so the fall-through
    // doesn't close what we just opened.
    let base = matched
    let searching = true
    let lineConsumed = false
    while (searching) {
      this.findNextNonspace()
      if (this.blank) break
      // commonmark's interrupts check: the last matched *container* is a
      // paragraph (a para under an item that just failed doesn't count)
      const interruptsPara = (this.stack[base]?.type ?? '') === 'paragraph'
      const ns = this.nextNonspace
      const ch = this.at(ns)

      if (this.indent >= CODE_INDENT && this.top().type !== 'paragraph') {
        this.closeTo(base)
        const d = this.draft('code-block', 'indented-code', ns)
        d.variant = 'indented'
        this.attach(d)
        this.advanceToColumn(this.column + CODE_INDENT)
        const rest = this.restOfLine()
        this.pushLine(d, rest)
        this.setEnd(d)
        this.extendAncestors()
        searching = false
        lineConsumed = true
        continue
      }

      if (ch === '>' && this.indent <= 3) {
        this.closeTo(base)
        const d = this.draft('blockquote', 'blockquote', ns)
        this.attach(d)
        this.setEnd(d)
        base = this.stack.length - 1
        this.offset = ns + 1
        this.column = this.nextNonspaceColumn + 1
        if (this.at(this.offset) === ' ' || this.at(this.offset) === '\t') {
          this.advanceToColumn(this.column + 1)
          this.partialTab = false
        }
        continue
      }

      if (this.indent <= 3) {
        const atx = scanAtxHeading(this.line, ns)
        if (!atx && !interruptsPara && !lazyPossible) {
          // 1-6 hashes glued to text: the classic `#Heading` slip. only
          // outside paragraphs: a line starting `#fragment` inside link
          // syntax is a url fragment, not a heading attempt
          let h = 0
          while (this.at(ns + h) === '#') h++
          if (h >= 1 && h <= 6) {
            const after = this.at(ns + h)
            if (after !== undefined && after !== ' ' && after !== '\t') {
              this.nearMisses.push({ code: 'atx-missing-space', offset: this.lineStart + ns })
            }
          }
        }
        this.tried(
          'atx-heading',
          atx !== null,
          atx ? undefined : 'no-heading-marker',
          'CommonMark 0.31.2 §4.2',
        )
        if (atx) {
          this.closeTo(base)
          const d = this.draft('heading', 'atx-heading', ns)
          d.variant = 'atx'
          d.depth = atx.depth
          d.lines = [this.line.slice(atx.contentOffset, atx.contentEnd)]
          d.lineOffsets = [this.lineStart + atx.contentOffset]
          d.lineNos = [this.lineNo]
          this.attach(d)
          this.setEnd(d)
          this.extendAncestors()
          this.closeTop()
          searching = false
          lineConsumed = true
          continue
        }

        const fence = scanFence(this.line, ns, this.indent)
        this.tried(
          'fenced-code',
          fence !== null,
          fence ? undefined : 'no-fence-marker',
          'CommonMark 0.31.2 §4.5',
        )
        if (fence) {
          this.closeTo(base)
          const d = this.draft('code-block', 'fenced-code', ns)
          d.variant = 'fenced'
          d.fenceChar = fence.char
          d.fenceLength = fence.length
          d.fenceColumn = fence.column
          d.infoRaw = fence.info
          d.lines = []
          d.lineOffsets = []
          d.lineNos = []
          this.attach(d)
          this.setEnd(d)
          searching = false
          lineConsumed = true
          continue
        }

        const htmlType = htmlBlockStart(this.line, ns, interruptsPara || lazyPossible)
        this.tried(
          'html-block',
          htmlType !== null,
          htmlType === null ? 'no-start-condition' : `type-${htmlType}`,
          'CommonMark 0.31.2 §4.6',
        )
        if (htmlType === null && (interruptsPara || lazyPossible) && this.at(ns) === '<') {
          // a complete tag alone on the line would be an html block, but
          // type 7 can't interrupt a paragraph (§4.6)
          const tagEnd = scanHtmlTag(this.line, ns)
          if (tagEnd !== -1 && /^[ \t]*$/.test(this.line.slice(tagEnd))) {
            this.nearMisses.push({ code: 'html-block-in-paragraph', offset: this.lineStart + ns })
          }
        }
        if (htmlType !== null) {
          this.closeTo(base)
          const d = this.draft('html-block', 'html-block', ns)
          d.htmlType = htmlType
          // keep the leading spaces: example 150 says ` <div>` stays ` <div>`
          d.lines = [this.line.slice(this.offset)]
          d.lineOffsets = [this.lineStart + this.offset]
          d.lineNos = [this.lineNo]
          this.attach(d)
          this.setEnd(d)
          this.extendAncestors()
          if (htmlBlockEnd(htmlType, this.line.slice(ns))) this.closeTop()
          searching = false
          lineConsumed = true
          continue
        }

        // setext: the last matched container is the paragraph itself
        if (interruptsPara) {
          const level = scanSetextUnderline(this.line, ns)
          this.tried(
            'setext-heading',
            level !== null,
            level ? undefined : 'not-an-underline',
            'CommonMark 0.31.2 §4.3',
          )
          if (level) {
            const para = this.top()
            // pull reference definitions out first; a heading's content
            // can't be definitions (commonmark's setext start does this too)
            this.extractRefDefs(para, this.stack[base - 1])
            if ((para.lines ?? []).length === 0) {
              // definitions ate the paragraph: no heading; the underline
              // line just becomes paragraph text (spec example 216)
              searching = false
              continue
            }
            para.type = 'heading'
            para.rule = 'setext-heading'
            para.variant = 'setext'
            para.depth = level
            this.setEnd(para)
            this.extendAncestors()
            this.closeTop()
            searching = false
            lineConsumed = true
            continue
          }
        }

        const thematic = scanThematicBreak(this.line, ns)
        this.tried('thematic-break', thematic, undefined, 'CommonMark 0.31.2 §4.1')
        if (thematic) {
          this.closeTo(base)
          const d = this.draft('thematic-break', 'thematic-break', ns)
          this.attach(d)
          this.setEnd(d)
          this.extendAncestors()
          this.closeTop()
          searching = false
          lineConsumed = true
          continue
        }

        const marker = scanListMarker(
          this.line,
          ns,
          this.nextNonspaceColumn,
          interruptsPara,
          this.noteNearMiss,
        )
        this.tried(
          'list-item',
          marker !== null,
          marker ? undefined : 'no-marker',
          'CommonMark 0.31.2 §4.7',
        )
        if (marker) {
          // a marker exactly one column short of the closed item's content
          // indent is the classic "wanted to nest, under-indented by one".
          // bigger dedents are deliberate siblings, not near-misses -- this
          // rule fired constantly before the one-column guard.
          if (ns > 0 && this.stack.length > base + 1) {
            const closing = this.stack[base + 1]
            if (
              closing &&
              closing.type === 'list-item' &&
              (closing.contentCol ?? 0) - this.column === 1
            ) {
              this.nearMisses.push({
                code: 'list-nesting-under-indent',
                offset: this.lineStart + ns,
              })
            }
          }
          this.closeTo(base)
          const parent = this.top()
          if (!(parent.type === 'list' && this.listCompatible(parent, marker))) {
            const list = this.draft('list', 'list', ns)
            list.ordered = marker.ordered
            list.marker = marker.bullet
            list.delimiter = marker.ordered ? marker.delimiter : undefined
            list.start = marker.ordered ? marker.start : undefined
            list.tight = true
            this.attach(list)
          }
          const item = this.draft('list-item', 'list-item', ns)
          // content indent relative to the container's content column; the
          // container prefix width varies line to line (">> " vs "> > ")
          const relContent = marker.contentCol - this.column
          item.contentCol = relContent
          this.attach(item)
          base = this.stack.length - 1
          this.setEnd(item)
          this.extendAncestors()
          this.offset = ns
          this.column = this.nextNonspaceColumn
          this.advanceToColumn(marker.contentCol)
          continue
        }

        if (this.gfm && interruptsPara) {
          const madeTable = this.tryStartTable()
          this.tried(
            'table',
            madeTable,
            madeTable ? undefined : 'no-delimiter-row-match',
            'GFM Tables (extension)',
          )
          if (madeTable) {
            this.extendAncestors()
            searching = false
            lineConsumed = true
            continue
          }
        }
      }

      searching = false
    }

    // fall-through: paragraph continuation (normal, lazy, or fresh)
    if (lineConsumed) return
    const tipNow = this.top()
    const continuation = tipNow.type === 'paragraph' && (allMatched || lazyPossible)
    if (continuation) {
      const rest = this.restOfLine()
      this.pushLine(tipNow, rest)
      this.setEnd(tipNow)
      this.extendAncestors()
      return
    }

    this.closeTo(base)
    if (this.blank) {
      // container prefix ate the whole line (`>`, `-` with nothing after)
      return
    }
    const d = this.draft('paragraph', 'paragraph', this.offset)
    d.lines = []
    d.lineOffsets = []
    d.lineNos = []
    const rest = this.restOfLine()
    if (this.gfm && this.maybeTaskItem(rest)) {
      // marker-only line: no paragraph content at all
      this.setEnd(this.top())
      this.extendAncestors()
      return
    }
    this.attach(d)
    this.pushLine(d, rest)
    this.setEnd(d)
    this.extendAncestors()
  }

  /**
   * gfm tables break at the start of another block-level element; probe the
   * starts without side effects before committing a row.
   */
  private wouldStartBlock(): boolean {
    if (this.indent > 3) return true
    const ns = this.nextNonspace
    const ch = this.at(ns)
    if (ch === '>') return true
    if (scanAtxHeading(this.line, ns) !== null) return true
    if (scanFence(this.line, ns, this.nextNonspaceColumn) !== null) return true
    if (htmlBlockStart(this.line, ns, false) !== null) return true
    if (scanThematicBreak(this.line, ns)) return true
    if (scanListMarker(this.line, ns, this.nextNonspaceColumn, false, () => {}) !== null)
      return true
    return false
  }

  private listCompatible(list: Draft, m: ListMarkerMatch): boolean {
    if (list.ordered !== m.ordered) return false
    if (m.ordered) return list.delimiter === m.delimiter
    return list.marker === m.bullet
  }

  private pushLine(d: Draft, rest: { text: string; offset: number }): void {
    const lines = (d.lines ??= [])
    const offs = (d.lineOffsets ??= [])
    const nos = (d.lineNos ??= [])
    if (d.type === 'paragraph') {
      // cmark strips line-leading [ \t]+ from paragraph content, incl. inside
      // code spans; trailing ws stays for hardbreak detection
      const m = /^[ \t]+/.exec(rest.text)
      const lead = m ? m[0].length : 0
      // first line after a def-emptied paragraph re-anchors its span
      if (lines.length === 0)
        d.span.start = positionAt(this.doc, this.lineStart + rest.offset + lead)
      lines.push(rest.text.slice(lead))
      offs.push(this.lineStart + rest.offset + lead)
    } else {
      lines.push(rest.text)
      offs.push(this.lineStart + rest.offset)
    }
    nos.push(this.lineNo)
  }

  private fencedLine(d: Draft): void {
    const fenceCol = d.fenceColumn ?? 0
    if (this.indent <= 3) {
      const ch = this.at(this.nextNonspace)
      if (ch === '`' || ch === '~') {
        let len = 0
        let i = this.nextNonspace
        while (this.at(i) === ch) {
          len++
          i++
        }
        let j = i
        while (this.at(j) === ' ' || this.at(j) === '\t') j++
        if (j === this.line.length && len >= 3) {
          if (ch === d.fenceChar && len >= (d.fenceLength ?? 0)) {
            d.fenceClosed = true
            this.setEnd(d)
            this.extendAncestors()
            this.closeTop()
            return
          }
          // looks like a closing fence but isn't one for this block
          if (ch !== d.fenceChar) {
            this.nearMisses.push({
              code: 'fence-close-wrong-char',
              offset: this.lineStart + this.nextNonspace,
            })
          } else if (len < (d.fenceLength ?? 0)) {
            this.nearMisses.push({
              code: 'fence-close-too-short',
              offset: this.lineStart + this.nextNonspace,
              detail: (d.fenceChar ?? '`').repeat(d.fenceLength ?? 3),
            })
          }
        }
      }
    }
    // strip up to fenceColumn columns of leading whitespace from the
    // post-container slice, tabs split
    const rest = this.restOfLine()
    let text = ''
    let col = 0
    let i = 0
    while (col < fenceCol && i < rest.text.length) {
      const c = rest.text[i] ?? ''
      if (c === ' ') {
        col++
        i++
      } else if (c === '\t') {
        const next = col + (4 - (col % 4))
        if (next <= fenceCol) {
          col = next
          i++
        } else {
          text += ' '.repeat(next - fenceCol)
          col = next
          i++
        }
      } else break
    }
    text += rest.text.slice(i)
    this.pushLine(d, { text, offset: rest.offset + i })
    this.setEnd(d)
    this.extendAncestors()
  }

  private htmlLine(d: Draft): void {
    const rest = this.restOfLine()
    this.pushLine(d, rest)
    this.setEnd(d)
    this.extendAncestors()
    if (htmlBlockEnd(d.htmlType as HtmlBlockType, rest.text)) {
      this.extendAncestors()
      this.closeTop()
    }
  }

  // -- gfm tables -----------------------------------------------------------

  private tableRowLine(table: Draft): void {
    const rest = this.restOfLine()
    const row = this.draft('table-row', 'table-row', this.offset)
    const split = splitTableRow(rest.text)
    const width = (table.alignments ?? []).length
    // gfm: missing cells pad empty, excess cells drop
    const cells = split.cells.slice(0, width)
    const starts = split.starts.slice(0, width)
    while (cells.length < width) {
      cells.push('')
      starts.push(rest.text.length)
    }
    row.cells = cells
    row.cellStarts = starts
    row.lineOffset = this.lineStart + rest.offset
    row.lineNo = this.lineNo
    row.span.start = positionAt(this.doc, this.lineStart + rest.offset)
    row.span.end = positionAt(this.doc, this.lineStart + this.line.length)
    ;(table.body ??= []).push(row)
    this.setEnd(table)
    this.extendAncestors()
  }

  private tryStartTable(): boolean {
    const para = this.top()
    const lines = para.lines ?? []
    if (lines.length !== 1) return false
    const headerLine = lines[0] ?? ''
    const candidate = this.line.slice(this.nextNonspace)
    const delim = parseDelimiterRow(candidate)
    if (!delim) {
      // pipe-and-dash-ish but not a valid delimiter row: worth saying so
      const t = candidate.trim()
      if (
        headerLine.includes('|') &&
        (t.startsWith('|') || t.startsWith(':') || t.startsWith('-')) &&
        t.includes('-') &&
        t.includes('|')
      ) {
        this.nearMisses.push({
          code: 'table-delimiter-malformed',
          offset: this.lineStart + this.nextNonspace,
        })
      }
      return false
    }
    const headerCells = splitTableRow(headerLine).cells
    if (headerCells.length !== delim.length) {
      if (headerLine.includes('|')) {
        this.nearMisses.push({
          code: 'table-cell-count-mismatch',
          offset: this.lineStart + this.nextNonspace,
          detail: `header ${headerCells.length}, delimiter ${delim.length}`,
        })
      }
      return false
    }
    if (headerCells.length === 0) return false

    const headerRow = this.draft('table-row', 'table-row', 0)
    headerRow.startLine = para.startLine
    headerRow.span.start = para.span.start
    headerRow.span.end = positionAt(
      this.doc,
      (para.lineOffsets?.[0] ?? this.lineStart) + headerLine.length,
    )
    const headerSplit = splitTableRow(headerLine)
    headerRow.cells = headerSplit.cells
    headerRow.cellStarts = headerSplit.starts
    headerRow.lineOffset = para.lineOffsets?.[0] ?? this.lineStart
    headerRow.lineNo = para.lineNos?.[0] ?? this.lineNo

    para.type = 'table'
    para.rule = 'table'
    para.alignments = delim.map((c) => cellAlignment(c))
    para.header = headerRow
    para.body = []
    para.lines = undefined
    para.lineOffsets = undefined
    para.lineNos = undefined
    // the table stays open: body rows arrive through checkContinue
    this.setEnd(para)
    this.extendAncestors()
    return true
  }

  /**
   * gfm task list marker on the first line of a list item's first block.
   * mutates `rest` to drop the marker; returns true when nothing remains.
   */
  private maybeTaskItem(rest: { text: string; offset: number }): boolean {
    const item = this.top()
    if (item.type !== 'list-item' || item.children.length > 0) return false
    const m = /^ {0,3}\[([ xX])\](?=[ \t]|$)/.exec(rest.text)
    if (!m) return false
    item.checked = m[1] !== ' '
    item.taskMarker = {
      start: positionAt(this.doc, this.lineStart + rest.offset),
      end: positionAt(this.doc, this.lineStart + rest.offset + m[0].length),
    }
    const after = rest.text.slice(m[0].length)
    const hadGap = after.startsWith(' ') || after.startsWith('\t')
    rest.text = hadGap ? after.slice(1) : after
    rest.offset += m[0].length + (hadGap ? 1 : 0)
    return rest.text === ''
  }

  // -- container continuation ----------------------------------------------

  private checkContinue(d: Draft): boolean {
    switch (d.type) {
      case 'document':
        return true
      case 'blockquote': {
        if (this.blank) return false
        if (this.at(this.nextNonspace) !== '>') return false
        // the marker line belongs to the quote's span (tightness via line gaps)
        this.lineHadMarker = true
        this.setEnd(d)
        this.offset = this.nextNonspace + 1
        this.column = this.nextNonspaceColumn + 1
        if (this.at(this.offset) === ' ' || this.at(this.offset) === '\t') {
          this.advanceToColumn(this.column + 1)
          this.partialTab = false
        }
        return true
      }
      case 'list':
        return true
      case 'list-item': {
        if (this.blank) {
          if (d.children.length === 0 && d.startLine === this.lineNo - 1) return false
          return true
        }
        if (this.indent < (d.contentCol ?? 0)) return false
        this.advanceToColumn(this.column + (d.contentCol ?? 0))
        this.partialTab = false
        return true
      }
      case 'paragraph':
        return !this.blank
      case 'code-block':
        if (d.fenceChar !== undefined) return true
        if (this.blank) {
          // a blank line wide enough to still be indented keeps its remainder
          // ("      " -> "  "); narrower blanks contribute nothing
          if (this.indent >= CODE_INDENT) this.advanceToColumn(this.column + CODE_INDENT)
          else {
            this.offset = this.nextNonspace
            this.column = this.nextNonspaceColumn
          }
          this.partialTab = false
          return true
        }
        if (this.indent >= CODE_INDENT) {
          this.advanceToColumn(this.column + CODE_INDENT)
          this.partialTab = false
          return true
        }
        return false
      case 'html-block':
        return true
      case 'table':
        return !this.blank
      default:
        // heading, thematic-break, rows, definitions never stay open
        return false
    }
  }

  // -- finalization ---------------------------------------------------------

  private finalize(d: Draft, parent: Draft | undefined): void {
    switch (d.type) {
      case 'paragraph': {
        this.extractRefDefs(d, parent)
        if ((d.lines ?? []).length === 0) {
          const kids = parent?.children
          if (kids) {
            const i = kids.indexOf(d)
            if (i !== -1) kids.splice(i, 1)
          }
        }
        return
      }
      case 'code-block': {
        const lines = d.lines ?? []
        if (d.fenceChar === undefined) {
          while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
        } else if (d.fenceClosed !== true) {
          // fenced code that ran to EOF: the fence never closed
          this.nearMisses.push({
            code: 'fence-unclosed',
            offset: d.span.start.offset,
            detail: (d.fenceChar ?? '`').repeat(d.fenceLength ?? 3),
          })
        }
        d.literal = lines.length > 0 ? lines.join('\n') + '\n' : ''
        d.info =
          d.infoRaw !== undefined && d.infoRaw.trim() !== '' ? unescapeInfo(d.infoRaw) : undefined
        d.lines = undefined
        d.lineOffsets = undefined
        d.lineNos = undefined
        return
      }
      case 'html-block': {
        const lines = d.lines ?? []
        d.literal = lines.length > 0 ? lines.join('\n') + '\n' : ''
        d.lines = undefined
        return
      }
      case 'list': {
        // loose = a line gap before a following sibling item, or between two
        // children of an item (commonmark: endsWithBlankLine via sourcepos)
        let loose = false
        const items = d.children
        for (let i = 0; i < items.length && !loose; i++) {
          const item = items[i]
          const nextItem = items[i + 1]
          if (item && nextItem && item.span.end.line !== nextItem.span.start.line - 1) loose = true
          if (item) {
            const ch = item.children
            for (let j = 0; j < ch.length && !loose; j++) {
              const c = ch[j]
              const nc = ch[j + 1]
              if (c && nc && c.span.end.line !== nc.span.start.line - 1) loose = true
            }
          }
        }
        d.tight = !loose
        return
      }
      case 'document': {
        d.span.end = positionAt(this.doc, this.doc.text.length)
        return
      }
      default:
        return
    }
  }

  private extractRefDefs(para: Draft, parent: Draft | undefined): void {
    const lines = para.lines ?? []
    if (lines.length === 0 || (lines[0] ?? '')[0] !== '[') return
    const offsets = para.lineOffsets ?? []
    const nos = para.lineNos ?? []
    // join once and scan by offset; re-joining after every definition is
    // quadratic on definition-dense paragraphs (cost us a benchmark to find)
    const content = lines.join('\n')
    const starts: number[] = []
    let at = 0
    for (const line of lines) {
      starts.push(at)
      at += line.length + 1
    }
    let idx = 0
    let consumed = 0
    const defs: Draft[] = []
    while (idx < lines.length) {
      const r = scanRefDef(content, starts[idx] ?? 0)
      if (!r) break
      const def = this.draft('link-reference-definition', 'link-reference-definition', 0)
      def.startLine = nos[idx] ?? this.lineNo
      def.span.start = positionAt(this.doc, offsets[idx] ?? 0)
      const lastIdx = idx + r.lineCount - 1
      def.span.end = positionAt(this.doc, (offsets[lastIdx] ?? 0) + (lines[lastIdx] ?? '').length)
      def.normalizedLabel = r.normalizedLabel
      def.destination = r.destination
      def.title = r.title
      defs.push(def)
      // first definition wins (§4.14)
      if (!this.refMap.has(r.normalizedLabel)) {
        this.refMap.set(r.normalizedLabel, {
          normalizedLabel: r.normalizedLabel,
          destination: r.destination,
          title: r.title,
          span: def.span,
        })
      }
      idx += r.lineCount
      consumed = idx
    }
    if (consumed > 0) {
      para.lines = lines.slice(consumed)
      para.lineOffsets = offsets.slice(consumed)
      para.lineNos = nos.slice(consumed)
      const newStart = offsets[consumed]
      if (newStart !== undefined) para.span.start = positionAt(this.doc, newStart)
      if (parent) {
        const kids = parent.children
        const at2 = kids.indexOf(para)
        if (at2 !== -1) kids.splice(at2, 0, ...defs)
      }
    }
  }
}

// -- link reference definition scanning (§4.14) --------------------------------

function scanRefDef(
  content: string,
  from = 0,
): {
  normalizedLabel: string
  destination: string
  title: string | undefined
  lineCount: number
} | null {
  if (content[from] !== '[') return null
  const label = scanLinkLabel(content, from)
  if (!label) return null
  let i = label.end
  if (content[i] !== ':') return null
  i++
  const gap1 = scanWs(content, i, 1)
  if (gap1.newlines > 1) return null
  i = gap1.end
  const dest = scanLinkDestination(content, i)
  if (!dest) return null
  let title: string | undefined
  let consumed = dest.end
  const gap2 = scanWs(content, dest.end, 1)
  if (gap2.end > dest.end) {
    const t = scanLinkTitle(content, gap2.end)
    if (t && tailToEol(content, t.end).trim() === '') {
      title = t.value
      consumed = t.end
    }
  }
  if (title === undefined && tailToEol(content, dest.end).trim() !== '') return null
  const normalizedLabel = normalizeLabel(label.raw)
  if (normalizedLabel === '') return null
  return {
    normalizedLabel,
    destination: dest.value,
    title,
    lineCount: 1 + countNewlines(content, from, consumed),
  }
}

function scanWs(s: string, i: number, maxNewlines: number): { end: number; newlines: number } {
  let j = i
  let n = 0
  while (j < s.length) {
    const ch = s[j] ?? ''
    if (ch === ' ' || ch === '\t') j++
    else if (ch === '\n') {
      if (n >= maxNewlines) break
      n++
      j++
    } else break
  }
  return { end: j, newlines: n }
}

function tailToEol(s: string, i: number): string {
  const nl = s.indexOf('\n', i)
  return nl === -1 ? s.slice(i) : s.slice(i, nl)
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (s[i] === '\n') n++
  return n
}

function unescapeInfo(infoRaw: string): string {
  const trimmed = infoRaw.trim()
  let out = ''
  let i = 0
  while (i < trimmed.length) {
    const ch = trimmed[i]
    if (ch === '\\' && i + 1 < trimmed.length && isAsciiPunctuation(trimmed[i + 1] ?? '')) {
      out += trimmed[i + 1]
      i += 2
    } else if (ch === '&') {
      const ent = decodeEntityAt(trimmed, i)
      if (ent) {
        out += ent.value
        i = ent.end
      } else {
        out += ch
        i++
      }
    } else {
      out += ch
      i++
    }
  }
  return out
}

// -- gfm table row splitting ---------------------------------------------------

/** split on unescaped pipes; leading/trailing pipes are structural and dropped.
 * returns cell contents plus each cell's start index within the line. */
export function splitTableRow(line: string): { cells: string[]; starts: number[] } {
  const cells: string[] = []
  const starts: number[] = []
  let cur = ''
  let curStart = -1
  const s = line
  let i = s.startsWith('|') ? 1 : 0
  const begin = (): void => {
    if (curStart === -1) curStart = i
  }
  while (i < s.length) {
    const ch = s[i] ?? ''
    if (ch === '\\' && s[i + 1] === '|') {
      // cmark-gfm unescapes pipes while splitting rows
      begin()
      cur += '|'
      i += 2
      continue
    }
    if (ch === '|') {
      cells.push(cur)
      starts.push(curStart === -1 ? i : curStart)
      cur = ''
      curStart = -1
      i++
      continue
    }
    begin()
    cur += ch
    i++
  }
  // a trailing pipe is structural: the last separator already closed the row,
  // so the empty remainder after it is not a cell
  if (s.length > 0 && s.endsWith('|') && !s.endsWith('\\|')) {
    // no trailing cell
  } else if (cur !== '') {
    cells.push(cur)
    starts.push(curStart === -1 ? s.length : curStart)
  }
  return { cells, starts }
}

export function parseDelimiterRow(line: string): string[] | null {
  const { cells } = splitTableRow(line)
  if (cells.length === 0) return null
  for (const c of cells) {
    if (!/^[ \t]*:?-+:?[ \t]*$/.test(c)) return null
  }
  return cells
}

export function cellAlignment(cell: string): 'left' | 'center' | 'right' | 'none' {
  const left = cell.trimStart().startsWith(':')
  const right = cell.trimEnd().endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return 'none'
}

export function parseBlocks(doc: SourceDoc, gfm: boolean, trace?: TraceRecorder): BlockPhaseResult {
  return new BlockPhase(doc, gfm, trace).run()
}
