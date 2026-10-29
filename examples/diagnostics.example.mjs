// example 1: near-miss diagnostics. run: node examples/diagnostics.example.mjs
// tested by tests/examples/examples.spec.ts
import { analyze } from '../dist/index.js'

const readme = `# Release notes

**bold but never closed
[link](https://example.com
[x][undefined-label]

| column a | column b |
| --- |

see www.commonmark.org for the spec
`

const { diagnostics } = analyze(readme, { dialect: 'gfm' })
console.log(`${diagnostics.length} near-miss diagnostics:\n`)
for (const d of diagnostics) {
  const fix = d.fix ? ` (fix: ${JSON.stringify(d.fix.replacement)} at ${d.fix.start})` : ''
  console.log(
    `  ${String(d.span.start.line).padStart(2)}:${String(d.span.start.column).padStart(2)} ${d.severity.padEnd(5)} ${d.code}: ${d.message}${fix}`,
  )
}
