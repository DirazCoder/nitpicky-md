import { codePointAt, isUnicodeWhitespaceCp } from '../unicode'

// gfm extended autolinks, from the GFM spec ("Autolinks (extension)"):
// www. / http:// / https:// / ftp:// at a boundary, plus bare emails.
// boundaries: line start, after whitespace, or after * _ ~ ( only.

const TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', '*', '_', '~'])
const LOCAL = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'.split(''),
)
const DOMAIN = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split(''))

function atBoundary(s: string, i: number): boolean {
  if (i === 0) return true
  const ch = s[i - 1] ?? ''
  if (ch === '*' || ch === '_' || ch === '~' || ch === '(') return true
  return isUnicodeWhitespaceCp(codePointAt(s, i - 1))
}

/**
 * try to match an extended www/url autolink starting exactly at `i`.
 * returns null when there's nothing here (caller keeps scanning text).
 */
export function gfmAutolinkAt(
  s: string,
  i: number,
): { end: number; variant: 'www' | 'uri'; destination: string } | null {
  if (!atBoundary(s, i)) return null
  const lower = s.slice(i, i + 8).toLowerCase()
  let schemeLen = 0
  let isWww = false
  if (lower.startsWith('www.')) {
    isWww = true
    schemeLen = 4
  } else if (lower.startsWith('http://')) {
    schemeLen = 7
  } else if (lower.startsWith('https://')) {
    schemeLen = 8
  } else if (lower.startsWith('ftp://')) {
    schemeLen = 6
  }
  if (schemeLen === 0) return null
  let j = i + schemeLen
  if (isWww) {
    if (j >= s.length) return null
    // the text after www. must be a valid domain
    const d = scanValidDomain(s, j)
    if (!d) return null
    j = d.end
  } else {
    if (j >= s.length) return null
    const d = scanValidDomain(s, j)
    if (!d) return null
    j = d.end
  }
  // path: zero or more non-space non-< characters
  while (j < s.length) {
    const ch = s[j] ?? ''
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<') break
    j++
  }
  // trailing punctuation isn't part of the autolink
  while (j > i && TRAILING_PUNCT.has(s[j - 1] ?? '')) j--
  // unmatched trailing parens get cut
  while (j > i && s[j - 1] === ')') {
    let opens = 0
    let closes = 0
    for (let k = i; k < j; k++) {
      const c = s[k] ?? ''
      if (c === '(') opens++
      else if (c === ')') closes++
    }
    if (closes > opens) j--
    else break
  }
  // entity-looking `&...;` at the end stays out
  if (j > i && s[j - 1] === ';') {
    let k = j - 2
    while (k >= i && /[a-zA-Z0-9]/.test(s[k] ?? '')) k--
    if (k >= i && s[k] === '&') j = k
  }
  if (j <= i + schemeLen && isWww) return null
  const text = s.slice(i, j)
  return { end: j, variant: isWww ? 'www' : 'uri', destination: isWww ? 'http://' + text : text }
}

/**
 * try to match a gfm email autolink whose `@` is exactly at `i`.
 * returns the local part and domain when the whole thing validates.
 */
export function gfmEmailAt(s: string, i: number): { local: string; domain: string } | null {
  if (s[i] !== '@') return null
  // local part backwards
  let start = i
  while (start > 0 && LOCAL.has(s[start - 1] ?? '')) start--
  if (start === i) return null
  if (!atBoundary(s, start)) return null
  // domain forwards: segments of [alnum-_] separated by periods, >=1 period
  let j = i + 1
  let lastDot = -1
  let segStart = j
  for (;;) {
    if (j < s.length && DOMAIN.has(s[j] ?? '')) {
      j++
      continue
    }
    if (j < s.length && s[j] === '.') {
      if (j === segStart) break // empty segment ends the domain
      lastDot = j
      j++
      segStart = j
      continue
    }
    break
  }
  if (lastDot === -1) return null
  // a trailing period (empty final segment) isn't part of the domain
  if (lastDot === j - 1) j = lastDot
  const domain = s.slice(i + 1, j)
  if (domain === '') return null
  const last = domain[domain.length - 1] ?? ''
  if (last === '-' || last === '_' || last === '.') return null
  const local = s.slice(start, i)
  if (local === '') return null
  return { local, domain }
}

/** segments of alnum/_/- separated by periods, >=1 period, no _ in last two segments */
function scanValidDomain(s: string, i: number): { end: number } | null {
  let j = i
  let dots = 0
  let segLen = 0
  const segments: number[] = []
  for (;;) {
    const ch = s[j] ?? ''
    if (DOMAIN.has(ch)) {
      j++
      segLen++
      continue
    }
    if (ch === '.' && segLen > 0) {
      segments.push(segLen)
      dots++
      j++
      segLen = 0
      continue
    }
    break
  }
  if (segLen > 0) segments.push(segLen)
  else if (dots > 0) {
    dots--
    j-- // a trailing period isn't part of the domain
  }
  if (dots < 1) return null
  // no underscores in the last two segments -- count underscores per segment
  let idx = i
  let seg = 0
  const underscored: boolean[] = []
  let cur = false
  while (idx < j) {
    const ch = s[idx] ?? ''
    if (ch === '.') {
      underscored.push(cur)
      cur = false
      seg++
    } else if (ch === '_') cur = true
    idx++
  }
  if (seg === underscored.length) underscored.push(cur)
  const n = underscored.length
  if (n >= 2) {
    if (underscored[n - 1] || underscored[n - 2]) return null
  } else if (n === 1 && underscored[0]) return null
  return { end: j }
}
