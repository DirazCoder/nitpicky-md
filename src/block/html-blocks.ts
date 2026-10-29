import { scanHtmlTag } from '../inline/raw-html'

// html block start/end conditions, spec 0.31.2 §4.6. the seven types are
// numbered like the spec so provenance can cite them directly.

const TYPE1 = /^<(?:pre|script|style|textarea)(?=[ \t>]|$)/i
const TYPE2 = /^<!--/
const TYPE3 = /^<\?/
const TYPE4 = /^<![A-Za-z]/
const TYPE5 = /^<!\[CDATA\[/
const TYPE6 =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t>]|\/>|$)/i

export type HtmlBlockType = 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * which html block type starts at `ns` (offset of first nonspace char, ≤3 cols in)?
 * returns null when the line doesn't start an html block.
 * `canInterruptParagraph` must be false when the line continues a paragraph:
 * type 7 is banned there (§4.6).
 */
export function htmlBlockStart(
  line: string,
  ns: number,
  canInterruptParagraph: boolean,
): HtmlBlockType | null {
  const rest = line.slice(ns)
  if (TYPE1.test(rest)) return 1
  if (TYPE2.test(rest)) return 2
  if (TYPE3.test(rest)) return 3
  if (TYPE4.test(rest)) return 4
  if (TYPE5.test(rest)) return 5
  if (TYPE6.test(rest)) return 6
  if (!canInterruptParagraph && rest.startsWith('<')) {
    const end = scanHtmlTag(rest, 0)
    // complete tag, nothing but spaces/tabs after it
    if (end !== -1 && /^[ \t]*$/.test(rest.slice(end))) {
      const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest)
      const lower = name?.[1]?.toLowerCase() ?? ''
      // spec carves these out of type 7 bcz they're type 1 territory
      if (lower !== 'pre' && lower !== 'script' && lower !== 'style' && lower !== 'textarea')
        return 7
    }
  }
  return null
}

/** does `content` (a full line of html block content) meet the end condition for types 1-5? */
export function htmlBlockEnd(type: HtmlBlockType, content: string): boolean {
  switch (type) {
    case 1:
      return /<\/(?:pre|script|style|textarea)>/i.test(content)
    case 2:
      return content.includes('-->')
    case 3:
      return content.includes('?>')
    case 4:
      return content.includes('>')
    case 5:
      return content.includes(']]>')
    case 6:
    case 7:
      return false // they end on blank lines, handled by the caller
  }
}
