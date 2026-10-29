import type { NearMiss } from '../trace'

import { isDigit } from '../unicode'

// block construct scanners. all operate on (line, ns) where ns is the offset of
// the first non-space/tab char. callers must have checked indent <= 3 already
// (or intentionally relaxed it for container-relative starts).
//
// near-miss reasons: when a construct *almost* matched we say why, so
// diagnostics can be derived from the parse without re-deriving anything.
// the NearMiss type lives in trace.ts -- one vocabulary for decisions.

export interface AtxMatch {
  depth: 1 | 2 | 3 | 4 | 5 | 6
  /** offset where the heading content starts (after #s + required space) */
  contentOffset: number
  /** offset where the content ends, closing-# sequence and trailing ws stripped */
  contentEnd: number
}

export function scanAtxHeading(line: string, ns: number): AtxMatch | null {
  let hashes = 0
  let i = ns
  while (line[i] === '#') {
    hashes++
    i++
  }
  if (hashes < 1 || hashes > 6) return null
  // 0.31.2 requires a space or eol after the run of #s
  const after = line[i]
  if (after !== undefined && after !== ' ' && after !== '\t') return null
  let start = i
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++
  let end = line.length
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
  // closing sequence: run of #s at the end, either the whole content or preceded by whitespace
  let cs = end
  while (cs > start && line[cs - 1] === '#') cs--
  if (cs < end) {
    if (cs === start || line[cs - 1] === ' ' || line[cs - 1] === '\t') {
      end = cs
      while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
    }
  }
  return { depth: hashes as 1 | 2 | 3 | 4 | 5 | 6, contentOffset: start, contentEnd: end }
}

/** setext underline; only meaningful when a paragraph is open (caller checks) */
export function scanSetextUnderline(line: string, ns: number): 1 | 2 | null {
  const ch = line[ns]
  if (ch !== '=' && ch !== '-') return null
  let i = ns
  while (line[i] === ch) i++
  let j = i
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++
  if (j !== line.length) return null
  return ch === '=' ? 1 : 2
}

export function scanThematicBreak(line: string, ns: number): boolean {
  const ch = line[ns]
  if (ch !== '-' && ch !== '_' && ch !== '*') return null as unknown as boolean
  let count = 0
  for (let i = ns; i < line.length; i++) {
    const c = line[i]
    if (c === ch) count++
    else if (c !== ' ' && c !== '\t') return false
  }
  return count >= 3
}

export interface FenceMatch {
  char: '`' | '~'
  length: number
  /** column of the fence's first char (0-based, virtual cols with tabs) */
  column: number
  /** raw info string, needs entity/escape processing at finalize */
  info: string
}

export function scanFence(line: string, ns: number, column: number): FenceMatch | null {
  const ch = line[ns]
  if (ch !== '`' && ch !== '~') return null
  let len = 0
  let i = ns
  while (line[i] === ch) {
    len++
    i++
  }
  if (len < 3) return null
  const info = line.slice(i)
  // §4.5: info strings of backtick fences can't contain backticks
  if (ch === '`' && info.includes('`')) return null
  return { char: ch, length: len, column, info }
}

export interface ListMarkerMatch {
  ordered: boolean
  start: number
  bullet: '-' | '+' | '*'
  delimiter: '.' | ')'
  /** column just past the marker itself */
  afterMarkerCol: number
  /** column where item content begins */
  contentCol: number
  /** nothing but the marker on this line */
  blankAfter: boolean
}

/**
 * list marker scan, §4.7. `canInterruptParagraph` gates the two interrupt rules
 * (empty items can't interrupt; ordered must start at 1).
 * returns the match or null; sets nearMiss on the reason slot when it almost worked.
 */
export function scanListMarker(
  line: string,
  ns: number,
  column: number,
  canInterruptParagraph: boolean,
  nearMiss: (nm: NearMiss) => void,
): ListMarkerMatch | null {
  const ch = line[ns] ?? ''
  let ordered = false
  let start = 0
  let bullet: '-' | '+' | '*' = '-'
  let delimiter: '.' | ')' = '.'
  let afterMarker: number

  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch
    afterMarker = ns + 1
  } else if (isDigit(ch)) {
    let i = ns
    let digits = 0
    while (i < line.length && isDigit(line[i] ?? '')) {
      start = start * 10 + (line.charCodeAt(i) - 48)
      digits++
      i++
    }
    if (digits > 9) return null
    const d = line[i] ?? ''
    if (d !== '.' && d !== ')') return null
    ordered = true
    delimiter = d
    afterMarker = i + 1
  } else {
    return null
  }

  // what follows the marker decides the content indent
  let i = afterMarker
  let col = column + (afterMarker - ns)
  let spaces = 0
  while (i < line.length) {
    const c = line[i] ?? ''
    if (c === ' ') {
      spaces++
      col++
      i++
    } else if (c === '\t') {
      // tab advances to the next multiple of 4
      const width = 4 - (col % 4)
      spaces += width
      col += width
      i++
    } else break
  }
  const blank = i >= line.length
  if (!blank && spaces === 0) return null // `*foo` / `1.x` aren't list markers

  // §4.7: empty marker line or 5+ spaces of padding puts content at marker+1;
  // the leftover spaces then make the first line indented code (example 328)
  let contentCol: number
  if (blank || spaces > 4) {
    contentCol = column + (afterMarker - ns) + 1
  } else {
    contentCol = col
  }

  if (canInterruptParagraph) {
    if (blank) return null // empty items can't interrupt paragraphs
    if (ordered && start !== 1) {
      nearMiss({ code: 'list-interrupt-needs-start-1', offset: ns })
      return null
    }
  }

  return {
    ordered,
    start,
    bullet,
    delimiter,
    afterMarkerCol: column + (afterMarker - ns),
    contentCol,
    blankAfter: blank,
  }
}
