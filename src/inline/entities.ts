import { namedEntities } from '../entities.generated'

// character references, spec 0.31.2 §2.3.

export interface EntityScan {
  value: string
  end: number
}

const isAlnum = (ch: string | undefined) => {
  if (ch === undefined) return false
  const c = ch.charCodeAt(0)
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

/**
 * try to read a character reference at `i` (pointing at `&`).
 * named references require the trailing semicolon; numeric references are
 * clamped per spec (0 and out-of-range become U+FFFD, surrogates too).
 */
export function decodeEntityAt(s: string, i: number): EntityScan | null {
  // numeric: &#1234; or &#xDEAD;
  if (s[i + 1] === '#') {
    let j = i + 2
    let cp: number
    const hex = s[j] === 'x' || s[j] === 'X'
    if (hex) j++
    let digits = 0
    let value = 0
    while (j < s.length) {
      const ch = s[j] ?? ''
      const c = ch.charCodeAt(0)
      let d: number
      if (hex) {
        d =
          c >= 0x30 && c <= 0x39
            ? c - 0x30
            : c >= 0x61 && c <= 0x66
              ? c - 0x57
              : c >= 0x41 && c <= 0x46
                ? c - 0x37
                : -1
      } else {
        d = c >= 0x30 && c <= 0x39 ? c - 0x30 : -1
      }
      if (d === -1) break
      value = value * (hex ? 16 : 10) + d
      digits++
      j++
    }
    if (digits === 0 || digits > (hex ? 6 : 7) || s[j] !== ';') return null
    cp = value
    // spec: 0, >10FFFF, and surrogates all map to FFFD
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd
    return { value: String.fromCodePoint(cp), end: j + 1 }
  }
  // named: greedy alnum run, must end with ;
  let j = i + 1
  while (j < s.length && isAlnum(s[j])) j++
  if (j === i + 1) return null
  // entity names can't end with a digit-looking run that swallows the name --
  // greedy run + ';' + table lookup is exact bcz names are alnum-only
  if (s[j] !== ';') return null
  const name = s.slice(i + 1, j)
  const value = Object.prototype.hasOwnProperty.call(namedEntities, name)
    ? namedEntities[name]
    : undefined
  if (value === undefined) return null
  return { value, end: j + 1 }
}
