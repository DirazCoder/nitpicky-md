// example 2: parse provenance. run: node examples/provenance.example.mjs
// tested by tests/examples/examples.spec.ts
import { explain, formatExplanation } from '../dist/index.js'

const doc = `# Deploying

not a link: [docs](missing-paren

*emphasis* and **strong** mix badly: ***oops**
`

// why is the thing at line 3, column 14 not a link?
console.log('--- explain 3:14')
console.log(formatExplanation(explain(doc, { line: 3, column: 14 })))

// why is ***oops** bold and not bold+italic?
console.log('\n--- explain 5:36')
console.log(formatExplanation(explain(doc, { line: 5, column: 36 })))

// every AST node carries its producing rule + spec section
import { parse } from '../dist/index.js'
const ast = parse(doc)
const walk = (node, depth) => {
  const rule = node.rule ?? '?'
  const span = `${node.span.start.line}:${node.span.start.column}`
  console.log(`${'  '.repeat(depth)}${node.type} [${rule}] at ${span}`)
  for (const child of node.children ?? []) walk(child, depth + 1)
}
walk(ast, 0)
