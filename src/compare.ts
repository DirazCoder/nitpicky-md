import type { MdNode } from './ast'
import { childNodes } from './ast'
import { renderHtml } from './html'
import { decodeEntityAt } from './inline/entities'

// cross-dialect divergence: compare(doc, engines) parses the document with
// our profiles plus any injected engines and reports structural differences
// mapped back to source ranges. divergence is structural (normalized token
// trees), never raw string diffs. the normalization rules ARE the feature;
// they're validated by test: any two
// spec-passing engines must agree on every commonmark spec example after
// normalization.

export interface Engine {
  readonly name: string
  render(md: string): string
  /**
   * span-aware tokenization, when the engine can provide it. our profiles
   * implement this so divergences carry source ranges; injected html-string
   * engines don't.
   */
  tokens?(md: string): Token[]
}

/** our commonmark profile */
export const commonmarkProfile: Engine = {
  name: 'nitpicky/commonmark',
  render(md: string): string {
    return renderHtmlViaApi(md, 'commonmark')
  },
  tokens(md: string): Token[] {
    return astToTokensViaApi(md, 'commonmark')
  },
}

/** our gfm profile */
export const gfmProfile: Engine = {
  name: 'nitpicky/gfm',
  render(md: string): string {
    return renderHtmlViaApi(md, 'gfm')
  },
  tokens(md: string): Token[] {
    return astToTokensViaApi(md, 'gfm')
  },
}

// late-bound to avoid a static import cycle (api.ts re-exports compare)
let renderViaApi: ((md: string, dialect: 'commonmark' | 'gfm') => string) | undefined
let astViaApi: ((md: string, dialect: 'commonmark' | 'gfm') => MdNode) | undefined
export function bindRenderer(
  fn: (md: string, dialect: 'commonmark' | 'gfm') => string,
  ast: (md: string, dialect: 'commonmark' | 'gfm') => MdNode,
): void {
  renderViaApi = fn
  astViaApi = ast
}
function renderHtmlViaApi(md: string, dialect: 'commonmark' | 'gfm'): string {
  if (!renderViaApi) throw new Error('compare() needs bindRenderer -- call it from api.ts')
  return renderViaApi(md, dialect)
}
function astToTokensViaApi(md: string, dialect: 'commonmark' | 'gfm'): Token[] {
  if (!astViaApi) throw new Error('compare() needs bindRenderer -- call it from api.ts')
  return astToTokens(astViaApi(md, dialect))
}

// -- html lexer + normalizer ---------------------------------------------------

export interface Token {
  /** element tag name, lowercase; '#text' for text, '#comment' dropped later */
  readonly tag: string
  /** sorted, normalized attributes */
  readonly attrs: readonly { readonly name: string; readonly value: string | undefined }[]
  readonly children: Token[]
  /** text content for #text tokens (entities decoded, edges trimmed) */
  readonly text?: string
  /** source span in OUR document when this token came from our AST */
  readonly span?: { readonly start: number; readonly end: number }
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const PRE_ISH = new Set(['pre', 'code', 'textarea', 'script', 'style'])
const BOOLEAN_ATTRS = new Set([
  'checked',
  'disabled',
  'readonly',
  'required',
  'selected',
  'autofocus',
  'multiple',
  'novalidate',
])

/** lex an html string into a normalized token tree */
export function normalizeHtml(html: string): Token[] {
  const roots: Token[] = []
  const stack: Token[] = []
  const top = (): Token[] => (stack.length > 0 ? (stack[stack.length - 1]?.children ?? []) : roots)
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      pushText(html.slice(i), undefined)
      break
    }
    if (lt > i) pushText(html.slice(i, lt), undefined)
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close === -1 ? html.length : close + 3
      continue
    }
    if (html[lt + 1] === '/') {
      const gt = html.indexOf('>', lt)
      const name =
        html
          .slice(lt + 2, gt === -1 ? html.length : gt)
          .trim()
          .toLowerCase()
          .split(/[\s/]/)[0] ?? ''
      i = gt === -1 ? html.length : gt + 1
      // pop to the matching open tag (tolerate nesting slop)
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]?.tag === name) {
          stack.length = k
          break
        }
      }
      continue
    }
    const gt = findTagEnd(html, lt)
    if (gt === -1) {
      pushText(html.slice(lt), undefined)
      break
    }
    const raw = html.slice(lt + 1, gt)
    i = gt + 1
    const parsed = parseTagBody(raw)
    if (!parsed) continue
    const token: Token = { tag: parsed.name, attrs: parsed.attrs, children: [] }
    top().push(token)
    if (!VOID.has(parsed.name) && !parsed.selfClosed) stack.push(token)
  }

  function pushText(raw: string, span: { start: number; end: number } | undefined): void {
    const parentTag = stack[stack.length - 1]?.tag
    let text = decodeEntities(raw)
    if (!PRE_ISH.has(parentTag ?? '')) {
      text = text.trim()
    }
    if (text === '') return
    const last = top()[top().length - 1]
    if (last?.tag === '#text') {
      // coalesce adjacent text nodes
      ;(last as { text?: string }).text =
        `${last.text ?? ''}${PRE_ISH.has(parentTag ?? '') ? '' : ' '}${text}`
      return
    }
    const textToken: Token = { tag: '#text', attrs: [], children: [], text }
    if (span !== undefined) (textToken as { span?: { start: number; end: number } }).span = span
    top().push(textToken)
  }

  function decodeEntities(s: string): string {
    let out = ''
    let j = 0
    while (j < s.length) {
      if (s[j] === '&') {
        const ent = decodeEntityAt(s, j)
        if (ent) {
          out += ent.value
          j = ent.end
          continue
        }
      }
      out += s[j] ?? ''
      j++
    }
    return out
  }

  return roots
}

function findTagEnd(html: string, from: number): number {
  // quoted attribute values can contain >
  let i = from + 1
  let quote = ''
  while (i < html.length) {
    const ch = html[i] ?? ''
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
    i++
  }
  return -1
}

function parseTagBody(
  raw: string,
): { name: string; attrs: Token['attrs']; selfClosed: boolean } | null {
  const selfClosed = raw.endsWith('/')
  const body = selfClosed ? raw.slice(0, -1) : raw
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(body)
  if (!nameMatch) return null
  const name = (nameMatch[0] ?? '').toLowerCase()
  const rest = body.slice(name.length)
  const attrs: { name: string; value: string | undefined }[] = []
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest)) !== null) {
    const an = (m[1] ?? '').toLowerCase()
    let av: string | undefined
    if (m[2] !== undefined) {
      av = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2]
      av = av.replace(/&(#?[a-zA-Z0-9]+);?/g, (whole, ent: string) => {
        const decoded = decodeEntityAt(`&${ent};`, 0)
        return decoded ? decoded.value : whole
      })
    }
    // boolean attrs: checked="" == checked
    if (av === '' && BOOLEAN_ATTRS.has(an)) av = undefined
    // gfm table alignment: style="text-align:center" == align="center"
    if (an === 'style' && av !== undefined) {
      const align = /text-align:\s*(center|left|right)/i.exec(av)
      if (align) {
        attrs.push({ name: 'align', value: (align[1] ?? '').toLowerCase() })
        continue
      }
    }
    if (an === 'align' && av !== undefined) {
      attrs.push({ name: 'align', value: av.toLowerCase() })
      continue
    }
    attrs.push({ name: an, value: av })
  }
  attrs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { name, attrs, selfClosed }
}

// -- our AST -> normalized tokens (with spans) ---------------------------------

export function astToTokens(node: MdNode): Token[] {
  // render our node to html, lex it, then attach spans by walking our AST
  // in the same order: our renderer is deterministic, and the token tree of
  // our own output has exactly the nodes our AST has. the alignment walk
  // pairs element tokens with AST nodes via render order.
  const html = renderHtml(node as never)
  const tokens = normalizeHtml(html)
  const spans: { start: number; end: number }[] = []
  collectSpans(node, spans)
  let k = 0
  const attach = (tokensArr: Token[]): void => {
    for (const t of tokensArr) {
      if (t.tag !== '#text' && k < spans.length) {
        const sp = spans[k]
        if (sp !== undefined) {
          ;(t as { span?: { start: number; end: number } }).span = sp
        }
        k++
      }
      attach(t.children)
    }
  }
  attach(tokens)
  return tokens
}

function collectSpans(node: MdNode, out: { start: number; end: number }[]): void {
  const s = (node as { span?: { start?: { offset: number }; end?: { offset: number } } }).span
  // skip container-ish nodes whose html element has no single source range
  const CONTAINERS = new Set([
    'document',
    'paragraph',
    'heading',
    'blockquote',
    'list',
    'list-item',
    'table',
    'table-row',
    'table-cell',
    'link-reference-definition',
  ])
  if (s?.start && s.end && !CONTAINERS.has(node.type)) {
    out.push({ start: s.start.offset, end: s.end.offset })
  }
  for (const c of childNodes(node)) collectSpans(c, out)
}

// -- structural diff -----------------------------------------------------------

export interface Divergence {
  /** the two engines that disagree */
  readonly engines: readonly [string, string]
  /** where in the tree, e.g. "document > ul > li[1] > p" */
  readonly path: string
  readonly description: string
  /** source range from our AST when one of the engines is ours */
  readonly span?: { readonly start: number; readonly end: number }
}

export interface DivergenceReport {
  readonly engineNames: readonly string[]
  readonly divergences: readonly Divergence[]
}

export function compare(
  md: string,
  engines: readonly Engine[],
  options?: { readonly baseline?: Engine },
): DivergenceReport {
  const baseline = options?.baseline ?? commonmarkProfile
  const trees = new Map<string, Token[]>()
  const getTree = (e: Engine): Token[] => {
    const hit = trees.get(e.name)
    if (hit) return hit
    const tree = e.tokens ? e.tokens(md) : normalizeHtml(e.render(md))
    trees.set(e.name, tree)
    return tree
  }
  const baseTree = getTree(baseline)
  const baseSpans = new Map<string, { start: number; end: number }>()
  const divergences: Divergence[] = []
  for (const engine of engines) {
    if (engine.name === baseline.name) continue
    const tree = getTree(engine)
    const diffs: {
      path: string
      description: string
      spanTag: { start: number; end: number } | undefined
    }[] = []
    diffTrees(baseTree, tree, 'document', diffs)
    for (const d of diffs) {
      const div: {
        engines: [string, string]
        path: string
        description: string
        span?: { start: number; end: number }
      } = {
        engines: [baseline.name, engine.name],
        path: d.path,
        description: d.description,
      }
      if (d.spanTag !== undefined) div.span = d.spanTag
      divergences.push(div)
    }
    void baseSpans
  }
  return { engineNames: engines.map((e) => e.name), divergences }
}

function tokenKey(t: Token): string {
  if (t.tag === '#text') return `#text ${JSON.stringify(t.text ?? '')}`
  const attrs = t.attrs
    .map((a) => (a.value === undefined ? a.name : `${a.name}=${JSON.stringify(a.value)}`))
    .join(' ')
  return `<${t.tag}${attrs ? ' ' + attrs : ''}>`
}

function diffTrees(
  a: readonly Token[],
  b: readonly Token[],
  path: string,
  out: {
    path: string
    description: string
    spanTag: { start: number; end: number } | undefined
  }[],
): void {
  // align children by key with a simple LCS so insertions don't cascade
  const ops = align(a, b)
  for (const op of ops) {
    if (op.kind === 'same') {
      diffTrees(op.a.children, op.b.children, `${path} > ${op.a.tag}`, out)
    } else if (op.kind === 'missing') {
      out.push({
        path,
        description: `${baselineName} renders ${tokenKey(op.a)}; other engine does not`,
        spanTag: op.a.span,
      })
    } else {
      out.push({
        path,
        description: `other engine renders ${tokenKey(op.b)}; ${baselineName} does not`,
        spanTag: op.b.span,
      })
    }
  }
}

let baselineName = 'baseline'
export function setBaselineName(name: string): void {
  baselineName = name
}

type AlignOp =
  { kind: 'same'; a: Token; b: Token } | { kind: 'missing'; a: Token } | { kind: 'extra'; b: Token }

/** LCS alignment on token keys; tokens are compared structurally downstream */
function align(a: readonly Token[], b: readonly Token[]): AlignOp[] {
  const ka = a.map(tokenKey)
  const kb = b.map(tokenKey)
  const n = ka.length
  const m = kb.length
  // dp table; capped so pathological html can't explode memory
  if (n * m > 4_000_000) {
    return [
      ...a.map((t): AlignOp => ({ kind: 'missing', a: t })),
      ...b.map((t): AlignOp => ({ kind: 'extra', b: t })),
    ]
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const at = (x: number, y: number): number => dp[x]?.[y] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i]
      if (row === undefined) continue
      row[j] = ka[i] === kb[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const ops: AlignOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      const at = a[i]
      const bt = b[j]
      if (at && bt) ops.push({ kind: 'same', a: at, b: bt })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      const at = a[i]
      if (at) ops.push({ kind: 'missing', a: at })
      i++
    } else {
      const bt = b[j]
      if (bt) ops.push({ kind: 'extra', b: bt })
      j++
    }
  }
  while (i < n) {
    const at = a[i]
    if (at) ops.push({ kind: 'missing', a: at })
    i++
  }
  while (j < m) {
    const bt = b[j]
    if (bt) ops.push({ kind: 'extra', b: bt })
    j++
  }
  return ops
}

export { renderHtml }
