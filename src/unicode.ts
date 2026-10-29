import { punctuationRanges, spaceSeparatorRanges } from './unicode-tables.generated'
import { caseFoldOverrides } from './case-folds.generated'

// spec 0.31.2 §2.2: unicode whitespace is Zs + \t \n \f \r (no vertical tab, yes this is deliberate)
const ASCII_WS = new Set([0x09, 0x0a, 0x0c, 0x0d])

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, cp: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (r === undefined) return false
    if (cp < r[0]) hi = mid - 1
    else if (cp > r[1]) lo = mid + 1
    else return true
  }
  return false
}

export function codePointAt(text: string, i: number): number {
  const cp = text.codePointAt(i)
  return cp ?? -1
}

export function isUnicodeWhitespaceCp(cp: number): boolean {
  return ASCII_WS.has(cp) || inRanges(spaceSeparatorRanges, cp)
}

export function isUnicodePunctuationCp(cp: number): boolean {
  return inRanges(punctuationRanges, cp)
}

// spec 0.31.2 §2.3 and the raw HTML grammar lean on ASCII punctuation a lot
export function isAsciiPunctuation(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (
    (c >= 0x21 && c <= 0x2f) ||
    (c >= 0x3a && c <= 0x40) ||
    (c >= 0x5b && c <= 0x60) ||
    (c >= 0x7b && c <= 0x7e)
  )
}

export function isAsciiLetter(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)
}

export function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c >= 0x30 && c <= 0x39
}

/** full case folding: toLowerCase unless CaseFolding.txt disagrees (sharp s etc) */
export function foldCase(cp: number): string {
  if (cp < 0x80) {
    const ch = String.fromCharCode(cp)
    return ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch
  }
  // overrides are sorted by code point; binary search
  let lo = 0
  let hi = caseFoldOverrides.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const entry = caseFoldOverrides[mid]
    if (!entry) break
    if (cp < entry[0]) hi = mid - 1
    else if (cp > entry[0]) lo = mid + 1
    else return entry[1] ?? ''
  }
  return String.fromCodePoint(cp).toLowerCase()
}
