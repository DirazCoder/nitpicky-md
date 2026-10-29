// benchmark runner: nitpicky-md vs markdown-it, marked, commonmark.js, micromark.
// method: tinybench, whole documents in memory, parse+render per iteration.
// engines configured closest to commonmark semantics (html on, no
// typographer/linkify, gfm for micromark) so the comparison is honest.
// run: npm run bench. writes bench/results/bench.json + prints a table.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bench } from 'tinybench'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ours = await import(join(root, 'dist/index.js'))

const commonmark = require('commonmark')
const MarkdownIt = require('markdown-it')
const { marked } = require('marked')
const micromark = require('micromark')
const gfmExt = require('micromark-extension-gfm')

const cmParser = new commonmark.Parser({ smart: false })
const cmRenderer = new commonmark.HtmlRenderer({ safe: false })
const mdIt = new MarkdownIt('commonmark', { html: true, typographer: false })
const micromarkOpts = { allowDangerousHtml: true, extensions: [gfmExt.gfm()] }

const specText = readFileSync(join(root, 'tests/fixtures/spec-0.31.2.txt'), 'utf8')

function buildMixedDoc(targetKB) {
  const unit = [
    '# heading',
    '',
    'a paragraph with *emphasis*, `code`, [a link](/url), and plain text. '.repeat(2),
    '',
    '- item one',
    '- item two',
    '  - nested',
    '',
    '> a quote',
    '> more quote',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| c | d |',
    '',
    '---',
    '',
  ].join('\n')
  return unit.repeat(Math.ceil((targetKB * 1024) / unit.length))
}

const growthPatterns = [
  { name: 'nested emphasis', build: (n) => '*a '.repeat(n) + 'b' },
  { name: 'unclosed brackets', build: (n) => '[a'.repeat(n) },
  { name: 'deep blockquotes', build: (n) => '> '.repeat(n) + 'x' },
  {
    name: 'huge table (rows)',
    build: (n) => '| a | b |\n| --- | --- |\n' + '| c | d |\n'.repeat(n),
  },
  { name: 'many closed links', build: (n) => '[a](/u)'.repeat(n) },
]

const docInputs = [
  { name: 'commonmark spec.txt', bytes: specText.length, text: specText },
  { name: 'mixed doc 32KB', bytes: 32 * 1024, text: buildMixedDoc(32) },
]

const engines = [
  {
    name: 'nitpicky-md',
    fn: (text) => {
      ours.render(text)
    },
    parseOnly: (text) => {
      ours.parse(text)
    },
  },
  {
    name: 'markdown-it',
    fn: (text) => {
      mdIt.render(text)
    },
    parseOnly: null,
  },
  {
    name: 'marked',
    fn: (text) => {
      marked.parse(text)
    },
    parseOnly: null,
  },
  {
    name: 'commonmark.js',
    fn: (text) => {
      cmRenderer.render(cmParser.parse(text))
    },
    parseOnly: (text) => {
      cmParser.parse(text)
    },
  },
  {
    name: 'micromark(gfm)',
    fn: (text) => {
      micromark.micromark(text, micromarkOpts)
    },
    parseOnly: null,
  },
]

const results = { meta: meta(), docs: {}, growth: {} }

function meta() {
  return {
    date: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    note: 'shared container, numbers are ballpark; compare orders of magnitude, not single percents',
  }
}

// per-document throughput
for (const input of docInputs) {
  const bench = new Bench({ warmupIterations: 10, iterations: 30 })
  for (const engine of engines) {
    bench.add(engine.name, () => engine.fn(input.text))
  }
  await bench.run()
  results.docs[input.name] = Object.fromEntries(
    bench.tasks.map((t) => [
      t.name,
      {
        msPerOp: Number((t.result?.latency?.mean ?? 0).toFixed(3)),
        opsPerSec: Math.round(t.result?.throughput?.mean ?? 0),
        samples: t.result?.latency?.samplesCount ?? 0,
      },
    ]),
  )
}

// growth: ours at several sizes for the linearity evidence. reference
// engines only at 8k units -- some of them go quadratic on these patterns
// and we're not here to hang CI measuring their worst case
for (const p of growthPatterns) {
  results.growth[p.name] = {}
  for (const n of [2000, 8000, 32000]) {
    const text = p.build(n)
    const bench = new Bench({ warmupIterations: 3, iterations: 10 })
    bench.add('nitpicky-md', () => {
      ours.render(text, { dialect: 'gfm' })
    })
    await bench.run()
    const t = bench.tasks[0]
    results.growth[p.name][`${String(n)}u`] = {
      msPerOp: Number((t?.result?.latency?.mean ?? 0).toFixed(2)),
      bytes: text.length,
    }
  }
  const midText = p.build(8000)
  for (const engine of engines.filter((e) => e.name !== 'nitpicky-md')) {
    const bench = new Bench({ warmupIterations: 2, iterations: 5 })
    bench.add(engine.name, () => engine.fn(midText))
    await bench.run()
    const t = bench.tasks[0]
    results.growth[p.name][`${engine.name}@8000u`] = {
      msPerOp: Number((t?.result?.latency?.mean ?? 0).toFixed(2)),
    }
  }
}

// parse-only comparison
{
  const bench = new Bench({ warmupIterations: 10, iterations: 30 })
  for (const engine of engines) {
    if (!engine.parseOnly) continue
    bench.add(engine.name, () => engine.parseOnly(specText))
  }
  await bench.run()
  results.parseOnly = Object.fromEntries(
    bench.tasks.map((t) => [
      t.name,
      {
        msPerOp: Number((t.result?.latency?.mean ?? 0).toFixed(3)),
        opsPerSec: Math.round(t.result?.throughput?.mean ?? 0),
      },
    ]),
  )
}

mkdirSync(join(root, 'bench/results'), { recursive: true })
writeFileSync(join(root, 'bench/results/bench.json'), JSON.stringify(results, null, 2))

// report
console.log(
  `\nbenchmarks ${results.meta.cpu}, node ${results.meta.node}, ${results.meta.cores} cores\n`,
)
for (const [doc, byEngine] of Object.entries(results.docs)) {
  console.log(`== ${doc} (parse+render) ==`)
  for (const [engine, r] of Object.entries(byEngine)) {
    console.log(
      `  ${engine.padEnd(16)} ${String(r.msPerOp).padStart(9)} ms/op   ${String(r.opsPerSec).padStart(6)} ops/s`,
    )
  }
}
console.log(`\n== parse only (spec.txt) ==`)
for (const [engine, r] of Object.entries(results.parseOnly ?? {})) {
  console.log(`  ${engine.padEnd(16)} ${String(r.msPerOp).padStart(9)} ms/op`)
}
console.log(`\n== growth (ours; ms per op) ==`)
for (const [name, sizes] of Object.entries(results.growth)) {
  const ours2k = sizes['2000u']?.msPerOp ?? 0
  const ours8k = sizes['8000u']?.msPerOp ?? 0
  const ours32k = sizes['32000u']?.msPerOp ?? 0
  const ratio = (ours32k / Math.max(ours2k, 0.001)).toFixed(1)
  const refs = Object.entries(sizes)
    .filter((k) => k[0].endsWith('@8000u'))
    .map((k) => `${k[0].replace('@8000u', '')}: ${k[1].msPerOp}ms`)
    .join('  ')
  console.log(
    `  ${name.padEnd(22)} 2k:${ours2k}ms 8k:${ours8k}ms 32k:${ours32k}ms (x${ratio} for 16x input)   ${refs}`,
  )
}
console.log('\nraw json: bench/results/bench.json')
