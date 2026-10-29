import type { InlineNode, Mutable } from '../ast'
import type { SourceDoc } from '../normalize'
import { positionAt } from '../normalize'
import {
  codePointAt,
  isAsciiPunctuation,
  isUnicodePunctuationCp,
  isUnicodeWhitespaceCp,
} from '../unicode'
import { decodeEntityAt } from './entities'
import { scanHtmlTag } from './raw-html'
import { normalizeLabel, scanLinkDestination, scanLinkLabel, scanLinkTitle } from './links'
import { gfmAutolinkAt, gfmEmailAt } from '../gfm/autolinks'
import type { RefDefinition } from '../block/parser'
import type { TraceRecorder, NearMiss } from '../trace'

// inline phase. the scanner builds a doubly-linked list so the emphasis and
// bracket algorithms can splice nodes without index bookkeeping, then converts
// to plain children arrays at the end. every node remembers the content index
// it started at (`contentIdx`) so spans and link-text recovery stay exact.

type Pos = { offset: number; line: number; column: number }

interface INode {
  type: string
  rule: string
  span: { start: Pos; end: Pos }
  /** content index this node starts at; stripped before the AST goes public */
  contentIdx?: number
  value?: string | undefined
  raw?: string | undefined
  children?: INode[] | undefined
  destination?: string | undefined
  title?: string | undefined
  variant?: string | undefined
  label?: string | undefined
  prev?: INode | null | undefined
  next?: INode | null | undefined
}

interface Delim {
  ch: '*' | '_' | '~'
  node: INode
  origLen: number
  len: number
  canOpen: boolean
  canClose: boolean
  /** consumed; skipped by scans. tombstoned instead of spliced out -- see
   *  processEmphasis. indices must stay stable for bottoms/delimTop. */
  dead?: boolean
}

interface Bracket {
  node: INode
  image: boolean
  /** delims.length when this bracket was pushed */
  delimTop: number
  active: boolean
}

export class InlineRun {
  private head: INode | null = null
  private tail: INode | null = null
  private readonly delims: Delim[] = []
  private readonly brackets: Bracket[] = []
  /** openers_bottom, keyed like cmark: char / closer-can-open / closer-len%3 */
  private readonly bottoms = new Map<string, number>()
  private pending = ''
  private pendingStart = 0
  private i = 0

  private readonly trace: TraceRecorder | undefined

  constructor(
    private readonly doc: SourceDoc,
    private readonly content: string,
    /** per content line: content start index, doc offset, 1-based line no, slice len in doc */
    private readonly lineMap: { start: number; offset: number; lineNo: number; docLen: number }[],
    private readonly refs: Map<string, RefDefinition>,
    private readonly gfm: boolean,
    private readonly nearMisses: NearMiss[],
    trace?: TraceRecorder,
  ) {
    this.trace = trace
  }

  private tried(construct: string, accepted: boolean, reason?: string, spec?: string): void {
    if (!this.trace) return
    const event: {
      construct: string
      phase: 'inline'
      verdict: 'accepted' | 'rejected'
      start: number
      reason?: string
      spec?: string
    } = {
      construct,
      phase: 'inline',
      verdict: accepted ? 'accepted' : 'rejected',
      start: this.posAt(this.i).offset,
    }
    if (reason !== undefined) event.reason = reason
    if (spec !== undefined) event.spec = spec
    this.trace.push(event)
  }

  parse(): Mutable<InlineNode>[] {
    this.scan()
    this.processEmphasis(0)
    // leftover openers that never found a closer: the classic `**bold*`.
    // tildes are excluded (`~10x`, `~/.config` are literals far more often
    // than unfinished strikethrough), and so are single `*`/`_` runs --
    // in prose those are globs (`*.h`, `*, foo`) far more often than
    // unfinished emphasis
    for (const d of this.delims) {
      if (d.dead) continue
      if (d.canOpen && d.len > 0 && d.ch !== '~' && d.origLen >= 2) {
        this.nearMisses.push({
          code: 'emphasis-unclosed',
          offset: this.posAt(d.node.contentIdx ?? 0).offset,
          detail: d.ch,
        })
      }
    }
    const out: Mutable<InlineNode>[] = []
    let n = this.head
    while (n) {
      const next = n.next ?? null
      delete n.prev
      delete n.next
      delete n.contentIdx
      out.push(n as unknown as Mutable<InlineNode>)
      n = next
    }
    return out
  }

  // -- position mapping ----------------------------------------------------

  private posAt(idx: number): Pos {
    let lo = 0
    let hi = this.lineMap.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((this.lineMap[mid]?.start ?? 0) <= idx) lo = mid
      else hi = mid - 1
    }
    const line = this.lineMap[lo]
    if (!line) return positionAt(this.doc, idx)
    const u = Math.min(idx - line.start, line.docLen)
    return positionAt(this.doc, line.offset + u)
  }

  // -- node helpers ----------------------------------------------------------

  private append(n: INode): void {
    n.prev = this.tail
    n.next = null
    if (this.tail) this.tail.next = n
    else this.head = n
    this.tail = n
  }

  private node(type: string, rule: string, from: number, to: number): INode {
    return {
      type,
      rule,
      contentIdx: from,
      span: { start: this.posAt(from), end: this.posAt(to) },
      prev: null,
      next: null,
    }
  }

  private textNode(value: string, from: number): INode {
    const n = this.node('text', 'text', from, from + value.length)
    n.value = value
    return n
  }

  /** unlink n; keeps head/tail valid (a removed head orphans the walk) */
  private removeNode(n: INode): void {
    if (this.head === n) this.head = n.next ?? null
    if (this.tail === n) this.tail = n.prev ?? null
    if (n.prev) n.prev.next = n.next
    if (n.next) n.next.prev = n.prev
    n.prev = null
    n.next = null
  }

  private flushPending(): void {
    if (this.pending === '') return
    this.append(this.textNode(this.pending, this.pendingStart))
    this.pending = ''
    this.pendingStart = this.i
  }

  private pushText(s: string): void {
    this.pending += s
  }

  // -- the scanner -----------------------------------------------------------

  private scan(): void {
    const s = this.content
    while (this.i < s.length) {
      const ch = s[this.i] ?? ''

      if (this.gfm) {
        const al = gfmAutolinkAt(s, this.i)
        if (al) {
          this.flushPending()
          const n = this.node('autolink', 'autolink', this.i, al.end)
          n.variant = al.variant === 'www' ? 'uri' : 'uri'
          n.destination = al.destination
          n.value = s.slice(this.i, al.end)
          this.append(n)
          this.i = al.end
          this.pendingStart = this.i
          continue
        }
        if (ch === '@') {
          const email = gfmEmailAt(s, this.i)
          if (email) {
            const localStart = this.i - email.local.length
            // the local part may contain `_`, which the delimiter pass already
            // flushed as text/delim nodes -- reclaim them from the list
            while (this.tail && (this.tail.contentIdx ?? 0) >= localStart) {
              const reclaimed = this.tail
              this.removeNode(reclaimed)
              for (let k = this.delims.length - 1; k >= 0; k--) {
                const d = this.delims[k]
                if (d && d.node === reclaimed) d.dead = true
              }
            }
            const keep =
              localStart > this.pendingStart
                ? this.pending.slice(0, localStart - this.pendingStart)
                : ''
            this.pending = ''
            if (keep !== '') this.append(this.textNode(keep, this.pendingStart))
            const n = this.node(
              'autolink',
              'autolink',
              localStart,
              this.i + email.domain.length + 1,
            )
            n.variant = 'email'
            n.destination = 'mailto:' + email.local + '@' + email.domain
            n.value = email.local + '@' + email.domain
            this.append(n)
            this.i += email.domain.length + 1
            this.pendingStart = this.i
            continue
          }
        }
      }

      switch (ch) {
        case '\\': {
          const next = s[this.i + 1]
          if (next === '\n') {
            this.pending = this.pending.replace(/ +$/, '')
            this.flushPending()
            const n = this.node('hard-break', 'hard-break', this.i, this.i + 2)
            n.variant = 'backslash'
            this.append(n)
            this.i += 2
            this.pendingStart = this.i
          } else if (next !== undefined && isAsciiPunctuation(next)) {
            this.flushPending()
            const n = this.node('escape', 'escape', this.i, this.i + 2)
            n.value = next
            this.append(n)
            this.i += 2
            this.pendingStart = this.i
          } else {
            this.pushText('\\')
            this.i++
          }
          break
        }
        case '`': {
          let len = 0
          let j = this.i
          while (s[j] === '`') {
            len++
            j++
          }
          // find the next run of exactly `len` backticks
          let k = j
          let found = -1
          while (k < s.length) {
            if (s[k] === '`') {
              let runLen = 0
              while (s[k + runLen] === '`') runLen++
              if (runLen === len) {
                found = k
                break
              }
              k += runLen
            } else k++
          }
          if (found === -1) {
            this.tried('code-span', false, 'no-matching-backtick-run', 'CommonMark 0.31.2 §6.10')
            this.pushText(s.slice(this.i, j))
            this.i = j
          } else {
            this.tried('code-span', true, undefined, 'CommonMark 0.31.2 §6.10')
            this.flushPending()
            // line endings become spaces first, then the one-space strip applies
            let inner = s.slice(j, found).replace(/\n/g, ' ')
            if (
              inner.length >= 2 &&
              inner[0] === ' ' &&
              inner[inner.length - 1] === ' ' &&
              inner.trim() !== ''
            ) {
              inner = inner.slice(1, -1)
            }
            const n = this.node('code-span', 'code-span', this.i, found + len)
            n.value = inner
            this.append(n)
            this.i = found + len
            this.pendingStart = this.i
          }
          break
        }
        case '<': {
          const auto = scanClassicAutolink(s, this.i)
          this.tried(
            'autolink',
            auto !== null,
            auto ? undefined : 'not-uri-or-email',
            'CommonMark 0.31.2 §6.6',
          )
          if (auto) {
            this.flushPending()
            const n = this.node('autolink', 'autolink', this.i, auto.end)
            n.variant = auto.variant
            n.destination = auto.destination
            n.value = auto.text
            this.append(n)
            this.i = auto.end
            this.pendingStart = this.i
            break
          }
          const tagEnd = scanHtmlTag(s, this.i)
          this.tried(
            'raw-html',
            tagEnd !== -1,
            tagEnd === -1 ? 'invalid-tag-syntax' : undefined,
            'CommonMark 0.31.2 §6.8',
          )
          if (tagEnd === -1 && this.i + 1 < s.length && /[A-Za-z!/]/.test(s[this.i + 1] ?? '')) {
            // typescript generics in prose (`<WithFaceDetection<{}>>`) look
            // like tags but aren't; skip when another `<` precedes any `>`
            const gt = s.indexOf('>', this.i)
            const lt = s.indexOf('<', this.i + 1)
            const generic = gt !== -1 && lt !== -1 && lt < gt
            if (!generic) {
              this.nearMisses.push({
                code: 'raw-html-malformed',
                offset: this.posAt(this.i).offset,
              })
            }
          }
          if (tagEnd !== -1) {
            this.flushPending()
            const n = this.node('raw-html', 'raw-html', this.i, tagEnd)
            n.value = s.slice(this.i, tagEnd)
            this.append(n)
            this.i = tagEnd
            this.pendingStart = this.i
            break
          }
          this.pushText('<')
          this.i++
          break
        }
        case '&': {
          const ent = decodeEntityAt(s, this.i)
          if (ent) {
            this.flushPending()
            const n = this.node('entity', 'entity', this.i, ent.end)
            n.raw = s.slice(this.i, ent.end)
            n.value = ent.value
            this.append(n)
            this.i = ent.end
            this.pendingStart = this.i
          } else {
            this.pushText('&')
            this.i++
          }
          break
        }
        case '*':
        case '_':
        case '~': {
          if (ch === '~' && !this.gfm) {
            this.pushText('~')
            this.i++
            break
          }
          this.handleDelimiter(ch)
          break
        }
        case '!': {
          if (s[this.i + 1] === '[') {
            this.flushPending()
            const run = this.textNode('![', this.i)
            this.append(run)
            this.brackets.push({
              node: run,
              image: true,
              delimTop: this.delims.length,
              active: true,
            })
            this.i += 2
            this.pendingStart = this.i
          } else {
            this.pushText('!')
            this.i++
          }
          break
        }
        case '[': {
          this.flushPending()
          const run = this.textNode('[', this.i)
          this.append(run)
          this.brackets.push({
            node: run,
            image: false,
            delimTop: this.delims.length,
            active: true,
          })
          this.i++
          this.pendingStart = this.i
          break
        }
        case ']': {
          this.handleCloseBracket()
          break
        }
        case '\n': {
          const spaces = countTrailingSpaces(this.pending)
          this.pending = spaces > 0 ? this.pending.slice(0, -spaces) : this.pending
          if (spaces >= 2) {
            const from = this.i - spaces
            this.flushPending()
            const n = this.node('hard-break', 'hard-break', from, this.i + 1)
            n.variant = 'spaces'
            this.append(n)
          } else {
            this.flushPending()
            const n = this.node('soft-break', 'soft-break', this.i, this.i + 1)
            this.append(n)
          }
          this.i++
          this.pendingStart = this.i
          break
        }
        default:
          this.pushText(ch)
          this.i++
      }
    }
    // paragraph-final whitespace is not content (spec §4.8)
    this.pending = this.pending.replace(/[ \t]+$/, '')
    this.flushPending()
    if (this.tail && this.tail.type === 'text') {
      this.tail.value = (this.tail.value ?? '').replace(/[ \t]+$/, '')
    }
  }

  // -- delimiters -------------------------------------------------------------

  private handleDelimiter(ch: '*' | '_' | '~'): void {
    const s = this.content
    let len = 0
    let j = this.i
    while (s[j] === ch) {
      len++
      j++
    }
    // gfm: tilde runs longer than 2 are plain text
    if (ch === '~' && len > 2) {
      this.pushText(s.slice(this.i, j))
      this.i = j
      return
    }
    const beforeCp = this.i > 0 ? codePointBefore(s, this.i) : -1
    const afterCp = j < s.length ? codePointAt(s, j) : -1
    const beforeWs = beforeCp === -1 || isUnicodeWhitespaceCp(beforeCp)
    const beforePunct = beforeCp !== -1 && isUnicodePunctuationCp(beforeCp)
    const afterWs = afterCp === -1 || isUnicodeWhitespaceCp(afterCp)
    const afterPunct = afterCp !== -1 && isUnicodePunctuationCp(afterCp)
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct)
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct)
    let canOpen: boolean
    let canClose: boolean
    if (ch === '_') {
      canOpen = leftFlanking && (!rightFlanking || beforePunct)
      canClose = rightFlanking && (!leftFlanking || afterPunct)
    } else {
      canOpen = leftFlanking
      canClose = rightFlanking
    }
    this.flushPending()
    const run = this.textNode(s.slice(this.i, j), this.i)
    this.append(run)
    this.delims.push({ ch, node: run, origLen: len, len, canOpen, canClose })
    this.i = j
    this.pendingStart = this.i
  }

  /** emphasis per the spec appendix, with cmark's openers_bottom guard.
   *  removals are tombstones, never splice(): splicing shifts every later
   *  index (invalidating bottoms and delimTop snapshots) and turns a `*a*`
   *  storm quadratic -- two O(n) memmoves per pair cost us 2s at 64k delims
   *  (CI caught it; see tests/unit/adversarial.spec.ts). a tombstone is one
   *  dead-slot skip, so the pass stays linear. */
  private processEmphasis(bottom: number): void {
    let closerIdx = bottom
    while (closerIdx < this.delims.length) {
      const closer = this.delims[closerIdx]
      if (!closer || closer.dead || !closer.canClose) {
        closerIdx++
        continue
      }
      const key = `${closer.ch}:${closer.canOpen ? 1 : 0}:${closer.origLen % 3}`
      const floor = this.bottoms.get(key) ?? bottom
      let openerIdx = closerIdx - 1
      let matched = -1
      while (openerIdx >= floor) {
        const opener = this.delims[openerIdx]
        if (!opener) break
        if (opener.dead) {
          openerIdx--
          continue
        }
        if (opener.ch === closer.ch && opener.canOpen) {
          if (closer.ch === '~' && opener.len !== closer.len) {
            // gfm strikethrough only pairs equal-length runs
            openerIdx--
            continue
          }
          const odd =
            (closer.canOpen || opener.canClose) &&
            (opener.origLen + closer.origLen) % 3 === 0 &&
            !(opener.origLen % 3 === 0 && closer.origLen % 3 === 0)
          if (!odd) {
            matched = openerIdx
            break
          }
        }
        openerIdx--
      }
      if (matched === -1) {
        if (this.trace) {
          this.trace.push({
            construct: 'emphasis',
            phase: 'inline',
            verdict: 'rejected',
            reason: closer.ch === '~' ? 'no-matching-tilde-run' : 'no-opener',
            start: closer.node.contentIdx ?? 0,
            spec: 'CommonMark 0.31.2 §6.2',
          })
        }
        this.bottoms.set(key, Math.max(floor, closerIdx - 1))
        // a closer that can reopen stays live for opener duty; otherwise
        // it's spent
        if (!closer.canOpen) closer.dead = true
        closerIdx++
        continue
      }
      const opener = this.delims[matched]
      if (!opener) break
      const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1
      if (this.trace) {
        this.trace.push({
          construct: closer.ch === '~' ? 'strikethrough' : use === 2 ? 'strong' : 'emphasis',
          phase: 'inline',
          verdict: 'accepted',
          start: (opener.node.contentIdx ?? 0) + opener.len - use,
          end: (closer.node.contentIdx ?? 0) + use,
          spec: closer.ch === '~' ? 'GFM Strikethrough (extension)' : 'CommonMark 0.31.2 §6.2',
        })
      }
      // nodes strictly between the two runs become the emphasis children
      const inner: INode[] = []
      let n = opener.node.next ?? null
      while (n && n !== closer.node) {
        const next = n.next ?? null
        delete n.prev
        delete n.next
        inner.push(n)
        n = next
      }
      const type = closer.ch === '~' ? 'strikethrough' : use === 2 ? 'strong' : 'emphasis'
      const emph = this.node(
        type,
        type,
        (opener.node.contentIdx ?? 0) + opener.len - use,
        (closer.node.contentIdx ?? 0) + use,
      )
      emph.children = inner
      emph.prev = opener.node
      emph.next = closer.node
      opener.node.next = emph
      closer.node.prev = emph
      if (this.tail === closer.node) this.tail = emph
      // shrink or drop the delimiter text nodes; len must hit 0 too or the
      // exhausted entry re-matches forever (cost us a hung spec run to see it).
      // spans shrink with the value or the leftovers lie about where they are.
      if (opener.len === use) {
        this.removeNode(opener.node)
        opener.node = emph
        opener.len = 0
      } else {
        opener.node.value = (opener.node.value ?? '').slice(0, opener.len - use)
        opener.node.span.end = this.posAt((opener.node.contentIdx ?? 0) + opener.len - use)
        opener.len -= use
      }
      if (closer.len === use) {
        this.removeNode(closer.node)
        closer.len = 0
      } else {
        closer.node.value = (closer.node.value ?? '').slice(use)
        closer.node.contentIdx = (closer.node.contentIdx ?? 0) + use
        closer.node.span.start = this.posAt(closer.node.contentIdx ?? 0)
        closer.len -= use
      }
      // tombstone delimiters strictly between; they're inside the new node
      for (let k = matched + 1; k < closerIdx; k++) {
        const d = this.delims[k]
        if (d) d.dead = true
      }
      if (closer.len === 0) closer.dead = true
      if (opener.len === 0) opener.dead = true
      // resume just past the opener; dead slots (opener/closer consumed,
      // between-run) are skipped by the checks at the top of the loop. a
      // surviving closer sits at matched+1 and gets re-visited.
      closerIdx = opener.len === 0 ? matched : matched + 1
    }
  }

  // -- brackets ---------------------------------------------------------------

  private handleCloseBracket(): void {
    const s = this.content
    const closeStart = this.i
    this.flushPending()
    const b = this.brackets[this.brackets.length - 1]
    if (!b) {
      this.pushText(']')
      this.i++
      return
    }
    if (!b.active) {
      this.brackets.pop()
      this.pushText(']')
      this.i++
      return
    }
    // inline link/image: `](dest "title")`
    if (s[this.i + 1] === '(') {
      const parsed = this.scanInlineLinkTail(this.i + 2)
      if (parsed) {
        this.tried('link', true, `variant-inline`, 'CommonMark 0.31.2 §6.6')
        this.makeLinkOrImage(b, parsed.destination, parsed.title, 'inline', undefined, parsed.end)
        return
      }
      this.nearMisses.push({ code: 'link-inline-malformed', offset: this.posAt(closeStart).offset })
      this.tried('link', false, 'no-destination-or-title', 'CommonMark 0.31.2 §6.6')
    }
    // reference links. a full `[label]` that scans but doesn't resolve kills
    // the link outright -- no shortcut fallback (commonmark parseCloseBracket)
    if (s[this.i + 1] === '[') {
      const lbl = scanLinkLabel(s, this.i + 1)
      if (lbl) {
        const norm = normalizeLabel(lbl.raw)
        const def = norm === '' ? undefined : this.refs.get(norm)
        if (def) {
          this.tried('link', true, 'variant-reference', 'CommonMark 0.31.2 §6.6')
          this.makeLinkOrImage(b, def.destination, def.title, 'reference', lbl.raw, lbl.end)
          return
        }
        if (looksLikeReferenceAttempt(lbl.raw, this.content, this.i + 1, false)) {
          this.nearMisses.push({
            code: 'link-reference-undefined',
            offset: this.posAt(this.i + 1).offset,
          })
        }
        this.tried(
          'link',
          false,
          norm === '' ? 'empty-label' : 'reference-undefined',
          'CommonMark 0.31.2 §6.6',
        )
        this.brackets.pop()
        this.pushText(']')
        this.i++
        return
      }
      // collapsed `[text][]`: empty raw label means use the link text
      if (s[this.i + 2] === ']') {
        const raw = rawTextBetween(this.content, b.node, closeStart, b.image)
        const norm = normalizeLabel(raw)
        const def = norm === '' ? undefined : this.refs.get(norm)
        if (def) {
          this.makeLinkOrImage(b, def.destination, def.title, 'collapsed', raw, closeStart + 3)
          return
        }
      }
    }
    // shortcut `[text]`
    {
      const raw = rawTextBetween(this.content, b.node, closeStart, b.image)
      const norm = normalizeLabel(raw)
      const def = norm === '' ? undefined : this.refs.get(norm)
      if (def) {
        this.tried(b.image ? 'image' : 'link', true, 'variant-shortcut', 'CommonMark 0.31.2 §6.6')
        this.makeLinkOrImage(b, def.destination, def.title, 'shortcut', raw, closeStart + 1)
        return
      }
      // precision gates: things that look like brackets but aren't
      // reference attempts (github alerts, code notation, reST citations),
      // and bare brackets in prose are too ambiguous, so only the
      // double-bracket shapes (followed by `](` or `][`) fire
      if (
        looksLikeReferenceAttempt(raw, this.content, closeStart, b.image) &&
        (this.content.startsWith('](', closeStart + 1) ||
          this.content.startsWith('][', closeStart + 1))
      ) {
        this.nearMisses.push({ code: 'link-reference-undefined', offset: b.node.span.start.offset })
      }
      this.tried(
        b.image ? 'image' : 'link',
        false,
        norm === '' ? 'empty-label' : 'reference-undefined',
        'CommonMark 0.31.2 §6.6',
      )
    }
    // nothing matched: the opener is dead and `]` is text
    this.brackets.pop()
    this.pushText(']')
    this.i++
  }

  private scanInlineLinkTail(
    from: number,
  ): { destination: string; title: string | undefined; end: number } | null {
    const s = this.content
    const ws1 = scanLinkWs(s, from)
    if (ws1.blank) return null
    let destEnd: number
    let destination = ''
    if (s[ws1.end] === ')') {
      // empty destination
      destEnd = ws1.end
    } else {
      const d = scanLinkDestination(s, ws1.end)
      if (!d) return null
      destination = d.value
      destEnd = d.end
    }
    const ws2 = scanLinkWs(s, destEnd)
    if (ws2.blank) return null
    let title: string | undefined
    let end = ws2.end
    const tch = s[ws2.end] ?? ''
    if (ws2.end > destEnd && (tch === '"' || tch === "'" || tch === '(')) {
      const t = scanLinkTitle(s, ws2.end)
      if (t) {
        title = t.value
        const ws3 = scanLinkWs(s, t.end)
        if (ws3.blank) return null
        end = ws3.end
      }
    }
    if (s[end] !== ')') return null
    return { destination, title, end: end + 1 }
  }

  private makeLinkOrImage(
    b: Bracket,
    destination: string,
    title: string | undefined,
    variant: 'inline' | 'reference' | 'collapsed' | 'shortcut',
    label: string | undefined,
    endIdx: number,
  ): void {
    // emphasis inside the bracket text resolves first (§6.6)
    this.processEmphasis(b.delimTop)
    this.delims.length = b.delimTop
    const kids: INode[] = []
    let n = b.node.next ?? null
    while (n) {
      const next = n.next ?? null
      delete n.prev
      delete n.next
      delete n.contentIdx
      kids.push(n)
      n = next
    }
    const isImage = b.image
    const node = this.node(
      isImage ? 'image' : 'link',
      isImage ? 'image' : 'link',
      b.node.contentIdx ?? 0,
      endIdx,
    )
    node.variant = variant
    node.destination = destination
    node.title = title
    node.label = label
    node.children = kids
    node.prev = b.node.prev ?? null
    node.next = null
    if (b.node.prev) b.node.prev.next = node
    else this.head = node
    this.tail = node
    this.brackets.pop()
    this.i = endIdx
    this.pendingStart = this.i
    // links may not contain links (§6.6); record it bcz "why is my outer
    // bracket literal" is a top-tier confusing case
    if (!isImage) {
      for (const br of this.brackets) {
        if (!br.image && br.active) {
          br.active = false
          if (this.trace) {
            this.trace.push({
              construct: 'link',
              phase: 'inline',
              verdict: 'rejected',
              reason: 'link-inside-link',
              start: br.node.span.start.offset,
              spec: 'CommonMark 0.31.2 §6.6',
            })
          }
        }
      }
    }
  }
}

// -- helpers -------------------------------------------------------------------

function countTrailingSpaces(s: string): number {
  let n = 0
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ' ') n++
    else break
  }
  return n
}

function codePointBefore(s: string, i: number): number {
  return s.codePointAt(i - 1) ?? -1
}

/** precision gates so bracket diagnostics don't fire on intentional prose */
function looksLikeReferenceAttempt(
  raw: string,
  content: string,
  closeStart: number,
  image: boolean,
): boolean {
  const trimmed = raw.trim()
  // github alerts: `> [!NOTE]` -- a plain bracket whose text is `!NOTE`
  if (!image && /^![A-Z][A-Z ]*$/.test(trimmed)) return false
  // code notation: [x], [i], [0], single chars and leading punctuation
  // (optional-arg style `[, config]`)
  if (trimmed.length <= 2) return false
  if (/^[,;]/.test(trimmed)) return false
  // reST citation: [foo]_
  if (content[closeStart + 1] === '_') return false
  return true
}

/** link text between an opener bracket node and the `]` (raw) */
function rawTextBetween(
  content: string,
  opener: INode,
  closeStart: number,
  image: boolean,
): string {
  return content.slice((opener.contentIdx ?? 0) + (image ? 2 : 1), closeStart)
}

/** whitespace inside inline links: ascii ws only, never a blank line. nbsp
 * is NOT whitespace here (spec 0.31.2 §6.6, example 507) */
function scanLinkWs(s: string, i: number): { end: number; blank: boolean } {
  let j = i
  let newlines = 0
  while (j < s.length) {
    const ch = s[j] ?? ''
    if (ch === ' ' || ch === '\t') j++
    else if (ch === '\n') {
      newlines++
      if (newlines >= 2) return { end: j, blank: true }
      j++
    } else break
  }
  return { end: j, blank: false }
}

// classic `<scheme:...>` / `<email>` autolinks, spec 0.31.2 §6.6
function scanClassicAutolink(
  s: string,
  i: number,
): { variant: 'uri' | 'email'; destination: string; text: string; end: number } | null {
  const close = s.indexOf('>', i + 1)
  if (close === -1) return null
  const inner = s.slice(i + 1, close)
  if (inner.includes('\n') || inner.includes('<')) return null
  const email =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.exec(
      inner,
    )
  if (email) {
    return { variant: 'email', destination: 'mailto:' + inner, text: inner, end: close + 1 }
  }
  const colon = inner.indexOf(':')
  if (colon >= 2 && colon <= 32 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(inner.slice(0, colon))) {
    for (const ch of inner.slice(colon + 1)) {
      const c = ch.codePointAt(0) ?? 0
      if (c < 0x20 || c === 0x7f || isUnicodeWhitespaceCp(c)) return null
    }
    return { variant: 'uri', destination: inner, text: inner, end: close + 1 }
  }
  return null
}
