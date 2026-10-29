import { isAsciiPunctuation, isUnicodeWhitespaceCp, codePointAt, foldCase } from '../unicode'
import { decodeEntityAt } from './entities'

// link destination / title / label scanning, spec 0.31.2 §6.6.
// shared by the inline parser and the link reference definition finalizer.

export interface Scan {
  /** the value with backslash escapes and character references processed */
  value: string
  /** index just past the scanned syntax */
  end: number
  /** raw source (before unescaping), for spans and diagnostics */
  raw: string
}

function unescape(s: string): string {
  // process \-escapes and entities into final characters
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length && isAsciiPunctuation(s[i + 1] ?? '')) {
      out += s[i + 1]
      i += 2
    } else if (ch === '&') {
      const ent = decodeEntityAt(s, i)
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

export function scanLinkDestination(s: string, i: number): Scan | null {
  if (s[i] === '<') {
    let j = i + 1
    let raw = ''
    while (j < s.length) {
      const ch = s[j] ?? ''
      if (ch === '>') return { value: unescape(raw), end: j + 1, raw: s.slice(i, j + 1) }
      if (ch === '\n' || ch === '<') return null
      if (ch === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1] ?? '')) {
        raw += s.slice(j, j + 2)
        j += 2
        continue
      }
      raw += ch
      j++
    }
    return null
  }
  // bare destination: no ctl/space, balanced parens
  let j = i
  let depth = 0
  let raw = ''
  while (j < s.length) {
    const ch = s[j] ?? ''
    const cp = codePointAt(s, j)
    if (ch === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1] ?? '')) {
      raw += s.slice(j, j + 2)
      j += 2
      continue
    }
    if (ch === '(') {
      depth++
      raw += ch
      j++
      continue
    }
    if (ch === ')') {
      if (depth === 0) break
      depth--
      raw += ch
      j++
      continue
    }
    // spec: dests exclude ascii control/space; nbsp is fine (example 507)
    if (cp <= 0x20 || cp === 0x7f) break
    raw += ch
    j++
  }
  if (j === i) return null // empty bare dest is invalid; empty <> dest is fine
  return { value: unescape(raw), end: j, raw }
}

export function scanLinkTitle(s: string, i: number): Scan | null {
  const open = s[i]
  if (open !== '"' && open !== "'" && open !== '(') return null
  const close = open === '(' ? ')' : open
  let j = i + 1
  let raw = ''
  while (j < s.length) {
    const ch = s[j] ?? ''
    if (ch === close) return { value: unescape(raw), end: j + 1, raw: s.slice(i, j + 1) }
    if (ch === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1] ?? '')) {
      raw += s.slice(j, j + 2)
      j += 2
      continue
    }
    raw += ch
    j++
  }
  return null
}

/** scan `[...]` starting at `[`; returns inner raw content (no brackets) */
export function scanLinkLabel(s: string, i: number): { raw: string; end: number } | null {
  if (s[i] !== '[') return null
  let j = i + 1
  while (j < s.length) {
    const ch = s[j] ?? ''
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '[') return null
    if (ch === ']') {
      const raw = s.slice(i + 1, j)
      // §6.6: labels can't be empty or longer than 999 chars
      if (raw.length === 0 || raw.length > 999) return null
      return { raw, end: j + 1 }
    }
    j++
  }
  return null
}

/** label normalization: trim, collapse internal ws, case-fold (§4.14) */
export function normalizeLabel(raw: string): string {
  let out = ''
  let pendingSpace = false
  let started = false
  let i = 0
  while (i < raw.length) {
    const cp = codePointAt(raw, i)
    const w = cp > 0xffff ? 2 : 1
    if (isUnicodeWhitespaceCp(cp)) {
      if (started) pendingSpace = true
      i += w
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    started = true
    out += String.fromCodePoint(cp)
    i += w
  }
  // fold each char: toLowerCase, except where full case folding says otherwise
  let folded = ''
  for (let k = 0; k < out.length;) {
    const cp = codePointAt(out, k)
    folded += foldCase(cp)
    k += cp > 0xffff ? 2 : 1
  }
  return folded
}
