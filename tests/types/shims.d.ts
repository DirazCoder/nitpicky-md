// local ambient types for reference parsers used in tests/benchmarks only.
// commonmark ships no types and @types/commonmark targets 0.27, so shim the
// surface we actually use.
declare module 'commonmark' {
  export class Parser {
    constructor(options?: { smart?: boolean })
    parse(input: string): Node
  }
  export class HtmlRenderer {
    constructor(options?: { safe?: boolean; softbreak?: string })
    render(node: Node): string
  }
  export class Node {
    constructor(type?: string, sourcepos?: unknown)
    literal: string | null
    type: string
  }
}
