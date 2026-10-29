import type { MdNode, Mutable } from './ast'

// html renderer. iterative on purpose: fuzzing throws 100k-deep blockquote
// nests at us and recursion would blow the stack (known markdown-it behavior).

export function renderHtml(root: Mutable<MdNode>): string {
  let out = ''
  // work stack of frames: node to enter, cell to render, or literal to emit
  type Frame =
    | { kind: 'node'; node: MdNode; tight: boolean; lastInParent: boolean }
    | { kind: 'cell'; node: MdNode; tag: 'th' | 'td'; align: string }
    | { kind: 'text'; text: string }
  const stack: Frame[] = []
  const emit = (s: string): void => {
    out += s
  }
  const pushNode = (node: MdNode, tight: boolean, lastInParent = false): void => {
    stack.push({ kind: 'node', node, tight, lastInParent })
  }
  const pushText = (text: string): void => {
    stack.push({ kind: 'text', text })
  }
  const pushCell = (node: MdNode, tag: 'th' | 'td', align: string): void => {
    stack.push({ kind: 'cell', node, tag, align })
  }

  pushNode(root, false)
  while (stack.length > 0) {
    const f = stack.pop()
    if (!f) break
    if (f.kind === 'text') {
      emit(f.text)
      continue
    }
    if (f.kind === 'cell') {
      const align = f.align !== 'none' ? ` align="${f.align}"` : ''
      emit(`<${f.tag}${align}>`)
      pushText(`</${f.tag}>\n`)
      pushChildren(f.node, false)
      continue
    }
    const node = f.node
    const tight = f.tight
    const lastInParent = f.lastInParent
    switch (node.type) {
      case 'document': {
        pushChildren(node, false)
        break
      }
      case 'blockquote': {
        emit('<blockquote>\n')
        pushText('</blockquote>\n')
        pushChildren(node, false)
        break
      }
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul'
        if (node.ordered && node.start !== 1) emit(`<${tag} start="${node.start}">`)
        else emit(`<${tag}>`)
        emit('\n')
        pushText(`</${tag}>\n`)
        // tightness flows down to items
        pushChildren(node, node.tight)
        break
      }
      case 'list-item': {
        const inner: Mutable<MdNode>[] = node.children as Mutable<MdNode>[]
        const first = inner[0]
        const inlineFirst = tight && first?.type === 'paragraph'
        emit(inlineFirst || inner.length === 0 ? '<li>' : '<li>\n')
        if (node.checked !== undefined) {
          emit(
            node.checked
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ',
          )
        }
        pushText('</li>\n')
        pushChildren(node, tight)
        break
      }
      case 'paragraph': {
        if (tight) {
          // cmark: tight paragraph gets a trailing newline only when another
          // block follows it inside the item
          if (!lastInParent) pushText('\n')
          pushChildren(node, false)
        } else {
          emit('<p>')
          pushText('</p>\n')
          pushChildren(node, false)
        }
        break
      }
      case 'heading': {
        emit(`<h${node.depth}>`)
        pushText(`</h${node.depth}>\n`)
        pushChildren(node, false)
        break
      }
      case 'thematic-break': {
        emit('<hr />\n')
        break
      }
      case 'code-block': {
        let info = ''
        if (node.info !== undefined && node.info !== '') {
          const first = node.info.split(/[ \t]+/)[0] ?? ''
          if (first !== '') info = ` class="language-${escapeAttr(first)}"`
        }
        emit(`<pre><code${info}>`)
        pushText(escapeText(node.literal ?? '') + '</code></pre>\n')
        break
      }
      case 'html-block': {
        const lit = node.literal ?? ''
        pushText(lit.endsWith('\n') || lit === '' ? lit : lit + '\n')
        break
      }
      case 'table': {
        // LIFO discipline: everything that must emit after the children gets
        // pushed before them, in reverse emission order
        emit('<table>\n<thead>\n<tr>\n')
        pushText('</table>\n')
        if (node.body.length > 0) pushText('</tbody>\n')
        for (let i = node.body.length - 1; i >= 0; i--) {
          const row = node.body[i]
          if (!row) continue
          pushText('</tr>\n')
          const cells = row.children
          for (let j = cells.length - 1; j >= 0; j--) {
            const c = cells[j]
            const align = node.alignments[j] ?? 'none'
            if (c) pushCell(c, 'td', align)
          }
          pushText('<tr>\n')
        }
        if (node.body.length > 0) pushText('<tbody>\n')
        pushText('</tr>\n</thead>\n')
        const headerCells = node.header.children
        for (let i = headerCells.length - 1; i >= 0; i--) {
          const c = headerCells[i]
          const align = node.alignments[i] ?? 'none'
          if (c) pushCell(c, 'th', align)
        }
        break
      }
      case 'table-row':
      case 'table-cell':
        break
      case 'text': {
        emit(escapeText(node.value ?? ''))
        break
      }
      case 'escape': {
        emit(escapeText(node.value ?? ''))
        break
      }
      case 'entity': {
        emit(escapeText(node.value ?? ''))
        break
      }
      case 'code-span': {
        emit('<code>')
        pushText(escapeText(node.value ?? '') + '</code>')
        break
      }
      case 'emphasis': {
        emit('<em>')
        pushText('</em>')
        pushChildren(node, false)
        break
      }
      case 'strong': {
        emit('<strong>')
        pushText('</strong>')
        pushChildren(node, false)
        break
      }
      case 'strikethrough': {
        emit('<del>')
        pushText('</del>')
        pushChildren(node, false)
        break
      }
      case 'link': {
        emit(`<a href="${escapeHref(node.destination ?? '')}"`)
        if (node.title !== undefined) emit(` title="${escapeAttr(node.title)}"`)
        emit('>')
        pushText('</a>')
        pushChildren(node, false)
        break
      }
      case 'image': {
        emit(
          `<img src="${escapeHref(node.destination ?? '')}" alt="${escapeAttr(flattenAlt(node.children))}"`,
        )
        if (node.title !== undefined) emit(` title="${escapeAttr(node.title)}"`)
        emit(' />')
        break
      }
      case 'autolink': {
        emit(`<a href="${escapeHref(node.destination ?? '')}">${escapeText(node.value ?? '')}</a>`)
        break
      }
      case 'raw-html': {
        emit(node.value ?? '')
        break
      }
      case 'soft-break': {
        emit('\n')
        break
      }
      case 'hard-break': {
        emit('<br />\n')
        break
      }
      case 'link-reference-definition':
        break
      default: {
        const unreachable: never = node
        void unreachable
      }
    }
  }
  return out

  function pushChildren(node: MdNode, tightList: boolean): void {
    const kids = childList(node)
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i]
      if (c) pushNode(c, tightList, i === kids.length - 1)
    }
  }
}

function childList(node: MdNode): readonly MdNode[] {
  switch (node.type) {
    case 'document':
    case 'blockquote':
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'link':
    case 'image':
      return node.children
    case 'list':
      return node.children
    case 'list-item':
      return node.children
    case 'table-row':
      return node.children
    case 'table-cell':
      return node.children
    default:
      return []
  }
}

export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeAttr(s: string): string {
  return escapeText(s)
}

// cmark's houdini_escape_href: an allowlist of safe ascii, & and ' escaped as
// entities, everything else percent-encoded (non-ascii as utf-8 bytes)
const HREF_SAFE = /[A-Za-z0-9-_.+~!#$&*,;=@?/:()%]/

export function escapeHref(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch === '&') out += '&amp;'
    else if (ch === "'") out += '&#x27;'
    else if (ch !== '\n' && HREF_SAFE.test(ch)) out += ch
    else if (ch === '\n') out += '%0A'
    else {
      // manual utf-8: no Buffer (browser-neutral) and no TextEncoder (not in lib es2022)
      const cp = ch.codePointAt(0) ?? 0
      const bytes: number[] = []
      if (cp < 0x80) bytes.push(cp)
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
      else if (cp < 0x10000)
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      else
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        )
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

/** image alt: inline content flattened to plain text */
export function flattenAlt(children: readonly MdNode[] | undefined): string {
  let out = ''
  const walk = (nodes: readonly MdNode[]): void => {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
        case 'escape':
        case 'entity':
        case 'code-span':
        case 'autolink':
          out += n.value ?? ''
          break
        case 'soft-break':
          out += '\n'
          break
        case 'hard-break':
          out += '\n'
          break
        case 'image':
        case 'link':
        case 'emphasis':
        case 'strong':
        case 'strikethrough':
          walk(n.children)
          break
        case 'raw-html':
          break
        default:
          break
      }
    }
  }
  walk(children ?? [])
  return out
}
