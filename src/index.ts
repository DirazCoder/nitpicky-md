// library entry point. browser-safe: no node builtins anywhere under src/
// except src/cli (enforced by eslint + scripts/check-deps.mjs).
export {
  parse,
  render,
  renderNode,
  parseFull,
  analyze,
  explain,
  formatExplanation,
  compare,
  commonmarkProfile,
  gfmProfile,
} from './api'
export type {
  ParseOptions,
  ParseInternals,
  AnalyzeResult,
  ExplainOptions,
  Engine,
  DivergenceReport,
  Divergence,
} from './api'
export type { Diagnostic } from './diagnostics'
export { childNodes } from './ast'
export type { Alignment, RuleId } from './ast'
export type {
  BlockNode,
  InlineNode,
  MdNode,
  DocumentNode,
  ParagraphNode,
  HeadingNode,
  ThematicBreakNode,
  CodeBlockNode,
  HtmlBlockNode,
  BlockquoteNode,
  ListNode,
  ListItemNode,
  LinkReferenceDefinitionNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  TextNode,
  EscapeNode,
  EntityNode,
  CodeSpanNode,
  EmphasisNode,
  StrongNode,
  StrikethroughNode,
  LinkNode,
  ImageNode,
  AutolinkNode,
  RawHtmlNode,
  SoftBreakNode,
  HardBreakNode,
  SourceSpan,
  Position,
} from './ast'
