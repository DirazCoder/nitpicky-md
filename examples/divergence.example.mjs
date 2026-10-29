// example 3: cross-dialect divergence. run: node examples/divergence.example.mjs
// tested by tests/examples/examples.spec.ts
//
// the engines here (markdown-it) are devDependencies of THIS repo. in your
// project you'd install them yourself -- the published package has zero
// dependencies and loads engines from your node_modules at runtime.
import { compare, commonmarkProfile, gfmProfile } from '../dist/index.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MarkdownIt = require('markdown-it')
const mdIt = new MarkdownIt('commonmark', { html: true })

const doc = 'see www.commonmark.org and ~~struck~~ text\n'

const report = compare(doc, [gfmProfile, { name: 'markdown-it', render: (md) => mdIt.render(md) }])

console.log(`comparing: ${report.engineNames.join(' vs ')}\n`)
if (report.divergences.length === 0) {
  console.log('no divergence')
} else {
  for (const d of report.divergences) {
    const range = d.span
      ? ` [${d.span.start}..${d.span.end}) = ${JSON.stringify(doc.slice(d.span.start, d.span.end))}`
      : ''
    console.log(`  ${d.engines[0]} vs ${d.engines[1]}${range}\n    ${d.description}`)
  }
}

// equivalent CLI: nitpicky-md check docs/ --targets commonmark,gfm,markdown-it --fail-on-diff
void commonmarkProfile
