export interface SourceDoc {
  /** normalized text: \r\n and lone \r become \n, NUL becomes U+FFFD (§2.1) */
  readonly text: string
  readonly lines: readonly string[]
  /** offset of each line's first character, same length as lines */
  readonly lineStarts: readonly number[]
  /** per-line code-point column tables, built lazily; O(1) position queries */
  readonly columnCache: Map<number, Uint32Array>
}

export function normalizeSource(src: string): SourceDoc {
  let text = src
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n')
  if (text.includes('\0')) text = text.replace(/\0/g, '￿')
  const lines = text.split('\n')
  const lineStarts: number[] = []
  let off = 0
  for (const line of lines) {
    lineStarts.push(off)
    off += line.length + 1
  }
  return { text, lines, lineStarts, columnCache: new Map() }
}

/** code-point column (1-based) for every code-unit offset of a line, cached */
function columnsOf(doc: SourceDoc, lineIdx: number): Uint32Array {
  const hit = doc.columnCache.get(lineIdx)
  if (hit) return hit
  const line = doc.lines[lineIdx] ?? ''
  const cols = new Uint32Array(line.length + 1)
  let col = 1
  for (let i = 0; i < line.length;) {
    cols[i] = col
    const cp = line.codePointAt(i)
    if (cp === undefined) break
    i += cp > 0xffff ? 2 : 1
    col++
  }
  cols[line.length] = col
  doc.columnCache.set(lineIdx, cols)
  return cols
}

/** position of a code-unit offset: 1-based line, 1-based code-point column */
export function positionAt(
  doc: SourceDoc,
  offset: number,
): {
  offset: number
  line: number
  column: number
} {
  let lo = 0
  let hi = doc.lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((doc.lineStarts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  const start = doc.lineStarts[lo] ?? 0
  const line = doc.lines[lo] ?? ''
  const inLine = Math.min(offset - start, line.length)
  const col = columnsOf(doc, lo)[inLine] ?? 1
  return { offset, line: lo + 1, column: col }
}
