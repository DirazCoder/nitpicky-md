import type { RuleId } from './ast'
import type { TraceEvent } from './trace'

// provenance: which spec rule produced a node, with section numbers taken
// from the 0.31.2 spec structure itself (tests/fixtures/spec-0.31.2.txt).

export interface RuleSpec {
  readonly section: string
  readonly title: string
  readonly url: string
}

const CM = 'https://spec.commonmark.org/0.31.2/'
const GFM = 'https://github.github.com/gfm/'

export const RULE_SPECS: Readonly<Record<RuleId, RuleSpec>> = {
  document: { section: '§3', title: 'Blocks and inlines', url: `${CM}#blocks-and-inlines` },
  paragraph: { section: '§4.8', title: 'Paragraphs', url: `${CM}#paragraphs` },
  'atx-heading': { section: '§4.2', title: 'ATX headings', url: `${CM}#atx-headings` },
  'setext-heading': { section: '§4.3', title: 'Setext headings', url: `${CM}#setext-headings` },
  'thematic-break': { section: '§4.1', title: 'Thematic breaks', url: `${CM}#thematic-breaks` },
  'indented-code': {
    section: '§4.4',
    title: 'Indented code blocks',
    url: `${CM}#indented-code-blocks`,
  },
  'fenced-code': { section: '§4.5', title: 'Fenced code blocks', url: `${CM}#fenced-code-blocks` },
  'html-block': { section: '§4.6', title: 'HTML blocks', url: `${CM}#html-blocks` },
  blockquote: { section: '§5.1', title: 'Block quotes', url: `${CM}#block-quotes` },
  list: { section: '§5.3', title: 'Lists', url: `${CM}#lists` },
  'list-item': { section: '§5.2', title: 'List items', url: `${CM}#list-items` },
  'link-reference-definition': {
    section: '§4.7',
    title: 'Link reference definitions',
    url: `${CM}#link-reference-definitions`,
  },
  table: { section: 'GFM Tables', title: 'Tables (extension)', url: `${GFM}#tables-extension-` },
  'table-row': {
    section: 'GFM Tables',
    title: 'Tables (extension)',
    url: `${GFM}#tables-extension-`,
  },
  'table-cell': {
    section: 'GFM Tables',
    title: 'Tables (extension)',
    url: `${GFM}#tables-extension-`,
  },
  text: { section: '§6', title: 'Inlines', url: `${CM}#inlines` },
  escape: { section: '§2.4', title: 'Backslash escapes', url: `${CM}#backslash-escapes` },
  entity: {
    section: '§2.3',
    title: 'Entity and numeric character references',
    url: `${CM}#entity-and-numeric-character-references`,
  },
  'code-span': { section: '§6.10', title: 'Code spans', url: `${CM}#code-spans` },
  emphasis: {
    section: '§6.2',
    title: 'Emphasis and strong emphasis',
    url: `${CM}#emphasis-and-strong-emphasis`,
  },
  strong: {
    section: '§6.2',
    title: 'Emphasis and strong emphasis',
    url: `${CM}#emphasis-and-strong-emphasis`,
  },
  strikethrough: {
    section: 'GFM Strikethrough',
    title: 'Strikethrough (extension)',
    url: `${GFM}#strikethrough-extension-`,
  },
  link: { section: '§6.6', title: 'Links', url: `${CM}#links` },
  image: { section: '§6.7', title: 'Images', url: `${CM}#images` },
  autolink: { section: '§6.8', title: 'Autolinks', url: `${CM}#autolinks` },
  'raw-html': { section: '§6.9', title: 'Raw HTML', url: `${CM}#raw-html` },
  'soft-break': { section: '§6.11', title: 'Soft line breaks', url: `${CM}#soft-line-breaks` },
  'hard-break': { section: '§6.9', title: 'Hard line breaks', url: `${CM}#hard-line-breaks` },
}

/** human phrases for the common rejection reasons */
const REASON_NOTES: Record<string, string> = {
  'no-heading-marker': 'no # characters start the line',
  'no-fence-marker': 'no ``` or ~~~ starts the line',
  'no-start-condition': 'none of the seven html block start conditions matched',
  'not-an-underline': 'not a run of = or - followed only by whitespace',
  'no-marker': 'no list marker here',
  'no-delimiter-row-match': 'no delimiter row matched the header cell count',
  'no-matching-backtick-run': 'no backtick run of the same length follows',
  'not-uri-or-email': 'not a valid uri or email autolink',
  'invalid-tag-syntax': 'not a valid html tag',
  'no-opener': 'no matching opening delimiter found',
  'no-matching-tilde-run': 'no matching ~~ run found',
  'no-destination-or-title': 'the (...) part did not parse as destination + title',
  'reference-undefined': 'no definition exists for that label',
  'empty-label': 'the label is empty',
  'rule-of-three': 'rule of three blocked the pairing (CommonMark §6.2)',
}

export function reasonNote(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  return REASON_NOTES[reason] ?? reason
}

export function describeEvent(event: TraceEvent): string {
  const note = reasonNote(event.reason)
  if (event.verdict === 'accepted') {
    return `${event.construct} accepted${event.reason ? ` (${note ?? event.reason})` : ''}`
  }
  return `${event.construct} rejected${note ? `: ${note}` : ''}`
}
