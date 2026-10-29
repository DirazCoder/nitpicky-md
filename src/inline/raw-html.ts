import { isAsciiLetter, isDigit } from '../unicode'

// raw HTML grammar, spec 0.31.2 §6.8. used by the inline parser and by
// html block type 7 (complete tag alone on a line).
//
// returns the end offset (exclusive) of the tag starting at `start`
// (text[start] must be '<'), or null if it isn't a valid tag.

const isTagNameChar = (ch: string) => isAsciiLetter(ch) || isDigit(ch) || ch === '-'
const isAttrNameChar = (ch: string) =>
  isAsciiLetter(ch) || isDigit(ch) || ch === '_' || ch === ':' || ch === '.' || ch === '-'

// "spaces, tabs, and up to one line ending" -- the grammar allows one \n inside
// the whitespace runs of a tag, but not two
class GapScanner {
  private newlines = 0
  ok = true
  constructor(
    private text: string,
    private i: number,
  ) {}
  /** consume [ \t\n]* ; returns false if it would exceed one newline */
  scan(): number {
    for (; this.i < this.text.length;) {
      const ch = this.text[this.i]
      if (ch === ' ' || ch === '\t') {
        this.i++
      } else if (ch === '\n') {
        if (this.newlines >= 1) return this.fail()
        this.newlines++
        this.i++
      } else break
    }
    return this.i
  }
  private fail(): number {
    this.ok = false
    return this.i
  }
}

function scanTagName(text: string, i: number): number {
  if (i >= text.length || !isAsciiLetter(text[i] ?? '')) return -1
  i++
  while (i < text.length && isTagNameChar(text[i] ?? '')) i++
  return i
}

function scanOpenTag(text: string, start: number): number {
  // start is at '<'; name begins at start+1
  let i = scanTagName(text, start + 1)
  if (i === -1) return -1
  for (;;) {
    const gap = new GapScanner(text, i)
    const j = gap.scan()
    if (!gap.ok) return -1
    if (text[j] === '>') return j + 1
    if (text[j] === '/') {
      if (text[j + 1] === '>') return j + 2
      return -1
    }
    // attributes need separating whitespace (§6.8): <a href='b'title=t> is not a tag
    if (j === i) return -1
    // attribute name
    const nch = text[j] ?? ''
    if (!(isAsciiLetter(nch) || nch === '_' || nch === ':')) return -1
    let k = j + 1
    while (k < text.length && isAttrNameChar(text[k] ?? '')) k++
    i = k
    // optional value spec
    const gap2 = new GapScanner(text, i)
    const m = gap2.scan()
    if (!gap2.ok) return -1
    if (text[m] === '=') {
      const gap3 = new GapScanner(text, m + 1)
      const v = gap3.scan()
      if (!gap3.ok) return -1
      const q = text[v] ?? ''
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, v + 1)
        if (close === -1) return -1
        i = close + 1
      } else {
        // unquoted: nonempty, no ws, "'=<>`
        let u = v
        let ok = false
        while (u < text.length) {
          const c = text[u] ?? ''
          if (
            c === ' ' ||
            c === '\t' ||
            c === '\n' ||
            c === '"' ||
            c === "'" ||
            c === '=' ||
            c === '<' ||
            c === '>' ||
            c === '`'
          )
            break
          ok = true
          u++
        }
        if (!ok) return -1
        i = u
      }
    }
    // else: no value, loop back to whitespace check (handles `a b` and `a >`)
  }
}

function scanClosingTag(text: string, start: number): number {
  if (text[start + 1] !== '/') return -1
  const i = scanTagName(text, start + 2)
  if (i === -1) return -1
  const gap = new GapScanner(text, i)
  const j = gap.scan()
  if (!gap.ok || text[j] !== '>') return -1
  return j + 1
}

export function scanHtmlTag(text: string, start: number): number {
  const ch = text[start + 1]
  if (ch === '/') return scanClosingTag(text, start)
  if (ch === '?' || ch === '!') {
    // PI, declaration, CDATA, or comment -- find the terminator
    if (text.startsWith('<!--', start)) {
      // 0.31.2 follows WHATWG: <!--> and <!---> are complete comments
      if (text.startsWith('<!-->', start)) return start + 5
      if (text.startsWith('<!--->', start)) return start + 6
      const close = text.indexOf('-->', start + 4)
      return close === -1 ? -1 : close + 3
    }
    if (text.startsWith('<![CDATA[', start)) {
      const close = text.indexOf(']]>', start + 9)
      return close === -1 ? -1 : close + 3
    }
    if (ch === '!') {
      // declaration: <! letter ... >
      if (text.length > start + 2 && isAsciiLetter(text[start + 2] ?? '')) {
        const close = text.indexOf('>', start + 2)
        return close === -1 ? -1 : close + 1
      }
      return -1
    }
    // PI: <? ... ?>
    const close = text.indexOf('?>', start + 2)
    return close === -1 ? -1 : close + 2
  }
  if (ch !== undefined && isAsciiLetter(ch)) return scanOpenTag(text, start)
  return -1
}
