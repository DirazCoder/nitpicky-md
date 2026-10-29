// public AST. discriminated unions keyed on `type`, readonly everywhere.
// adding a node type breaks the build until every exhaustive switch is updated
// (html.ts, api.ts childNodes, provenance walk) -- that's the point.

export interface Position {
  readonly offset: number
  readonly line: number
  readonly column: number
}

// end is exclusive, like every sane span API
export interface SourceSpan {
  readonly start: Position
  readonly end: Position
}

export type Alignment = 'left' | 'center' | 'right' | 'none'

export type RuleId =
  | 'document'
  | 'paragraph'
  | 'atx-heading'
  | 'setext-heading'
  | 'thematic-break'
  | 'indented-code'
  | 'fenced-code'
  | 'html-block'
  | 'blockquote'
  | 'list'
  | 'list-item'
  | 'link-reference-definition'
  | 'table'
  | 'table-row'
  | 'table-cell'
  | 'text'
  | 'escape'
  | 'entity'
  | 'code-span'
  | 'emphasis'
  | 'strong'
  | 'strikethrough'
  | 'link'
  | 'image'
  | 'autolink'
  | 'raw-html'
  | 'soft-break'
  | 'hard-break'

interface NodeBase {
  readonly rule: RuleId
  readonly span: SourceSpan
}

export interface DocumentNode extends NodeBase {
  readonly type: 'document'
  readonly children: readonly BlockNode[]
}
export interface ParagraphNode extends NodeBase {
  readonly type: 'paragraph'
  readonly children: readonly InlineNode[]
}
export interface HeadingNode extends NodeBase {
  readonly type: 'heading'
  readonly variant: 'atx' | 'setext'
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6
  readonly children: readonly InlineNode[]
}
export interface ThematicBreakNode extends NodeBase {
  readonly type: 'thematic-break'
}
export interface CodeBlockNode extends NodeBase {
  readonly type: 'code-block'
  readonly variant: 'indented' | 'fenced'
  readonly literal: string
  /** info string, fences only; entities decoded, backslash escapes applied */
  readonly info?: string
}
export interface HtmlBlockNode extends NodeBase {
  readonly type: 'html-block'
  readonly literal: string
}
export interface BlockquoteNode extends NodeBase {
  readonly type: 'blockquote'
  readonly children: readonly BlockNode[]
}
export interface ListNode extends NodeBase {
  readonly type: 'list'
  readonly ordered: boolean
  readonly tight: boolean
  readonly marker: '-' | '+' | '*'
  /** ordered lists only */
  readonly delimiter?: '.' | ')'
  /** ordered lists only; 1 when absent */
  readonly start?: number
  readonly children: readonly ListItemNode[]
}
export interface ListItemNode extends NodeBase {
  readonly type: 'list-item'
  readonly children: readonly BlockNode[]
  /** gfm task lists only */
  readonly checked?: boolean
  /** span of the `[ ]`/`[x]` marker itself, gfm task lists only */
  readonly taskMarker?: SourceSpan
}
export interface LinkReferenceDefinitionNode extends NodeBase {
  readonly type: 'link-reference-definition'
  /** the label after normalization (case-folded, ws collapsed) used for lookups */
  readonly normalizedLabel: string
  readonly destination: string
  readonly title?: string
}
export interface TableNode extends NodeBase {
  readonly type: 'table'
  readonly alignments: readonly Alignment[]
  readonly header: TableRowNode
  readonly body: readonly TableRowNode[]
}
export interface TableRowNode extends NodeBase {
  readonly type: 'table-row'
  readonly children: readonly TableCellNode[]
}
export interface TableCellNode extends NodeBase {
  readonly type: 'table-cell'
  readonly children: readonly InlineNode[]
}

export type BlockNode =
  | DocumentNode
  | ParagraphNode
  | HeadingNode
  | ThematicBreakNode
  | CodeBlockNode
  | HtmlBlockNode
  | BlockquoteNode
  | ListNode
  | ListItemNode
  | LinkReferenceDefinitionNode
  | TableNode
  | TableRowNode
  | TableCellNode

export interface TextNode extends NodeBase {
  readonly type: 'text'
  readonly value: string
}
/** backslash-escaped punctuation, §2.4. we keep it a node so explain() can say why a `*` is literal */
export interface EscapeNode extends NodeBase {
  readonly type: 'escape'
  readonly value: string
}
/** character reference, §2.3. raw is the source form, value is the decoded text */
export interface EntityNode extends NodeBase {
  readonly type: 'entity'
  readonly raw: string
  readonly value: string
}
export interface CodeSpanNode extends NodeBase {
  readonly type: 'code-span'
  readonly value: string
}
export interface EmphasisNode extends NodeBase {
  readonly type: 'emphasis'
  readonly children: readonly InlineNode[]
}
export interface StrongNode extends NodeBase {
  readonly type: 'strong'
  readonly children: readonly InlineNode[]
}
/** gfm only */
export interface StrikethroughNode extends NodeBase {
  readonly type: 'strikethrough'
  readonly children: readonly InlineNode[]
}
export interface LinkNode extends NodeBase {
  readonly type: 'link'
  readonly variant: 'inline' | 'reference' | 'collapsed' | 'shortcut'
  readonly destination: string
  readonly title?: string
  readonly children: readonly InlineNode[]
  /** set for the non-inline variants; the label as written (pre-normalization) */
  readonly label?: string
}
/** children double as the alt text */
export interface ImageNode extends NodeBase {
  readonly type: 'image'
  readonly variant: 'inline' | 'reference' | 'collapsed' | 'shortcut'
  readonly destination: string
  readonly title?: string
  readonly children: readonly InlineNode[]
  readonly label?: string
}
export interface AutolinkNode extends NodeBase {
  readonly type: 'autolink'
  readonly variant: 'uri' | 'email'
  readonly destination: string
  readonly value: string
}
export interface RawHtmlNode extends NodeBase {
  readonly type: 'raw-html'
  readonly value: string
}
export interface SoftBreakNode extends NodeBase {
  readonly type: 'soft-break'
}
export interface HardBreakNode extends NodeBase {
  readonly type: 'hard-break'
  readonly variant: 'spaces' | 'backslash'
}

export type InlineNode =
  | TextNode
  | EscapeNode
  | EntityNode
  | CodeSpanNode
  | EmphasisNode
  | StrongNode
  | StrikethroughNode
  | LinkNode
  | ImageNode
  | AutolinkNode
  | RawHtmlNode
  | SoftBreakNode
  | HardBreakNode

export type MdNode = BlockNode | InlineNode

/** deep-mutable view used while building; Mutable<T> is assignable to T */
export type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : { -readonly [K in keyof T]: Mutable<T[K]> }

export function childNodes(node: MdNode): readonly MdNode[] {
  switch (node.type) {
    case 'document':
    case 'blockquote':
      return node.children
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
    case 'table':
      return [node.header, ...node.body]
    case 'table-row':
      return node.children
    case 'table-cell':
      return node.children
    case 'thematic-break':
    case 'code-block':
    case 'html-block':
    case 'link-reference-definition':
    case 'text':
    case 'escape':
    case 'entity':
    case 'code-span':
    case 'autolink':
    case 'raw-html':
    case 'soft-break':
    case 'hard-break':
      return []
    default: {
      // exhaustiveness: adding a node type without updating this switch is a build error
      const unreachable: never = node
      return unreachable
    }
  }
}
