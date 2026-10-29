// trace overhead benchmark: parse with trace off vs on, spec.txt corpus.
// the claim under test: tracing off costs nothing measurable
// -- the parse path only adds a truthiness check per decision when off.
// writes bench/results/trace.json and prints the comparison.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bench } from 'tinybench'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ours = await import(join(root, 'dist/index.js'))
const specText = readFileSync(join(root, 'tests/fixtures/spec-0.31.2.txt'), 'utf8')
const gfmSpec = readFileSync(join(root, 'tests/fixtures/gfm-spec.txt'), 'utf8')

function medianOf(fn, runs = 15) {
  const bench = new Bench({ iterations: runs, warmupIterations: 5 })
  bench.add('op', fn)
  return bench.run().then(() => bench.tasks[0]?.result?.latency?.mean ?? 0)
}

const inputs = [
  { name: 'commonmark spec.txt', text: specText, dialect: undefined },
  { name: 'gfm spec.txt', text: gfmSpec, dialect: 'gfm' },
]

const out = {
  meta: {
    date: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model ?? '?',
    cores: cpus().length,
  },
  runs: {},
}

for (const input of inputs) {
  const off = await medianOf(() =>
    ours.parse(input.text, input.dialect ? { dialect: input.dialect } : undefined),
  )
  const on = await medianOf(() =>
    ours.parse(
      input.text,
      input.dialect ? { dialect: input.dialect, trace: true } : { trace: true },
    ),
  )
  out.runs[input.name] = {
    traceOffMs: Number(off.toFixed(2)),
    traceOnMs: Number(on.toFixed(2)),
    overhead: `${((on / off - 1) * 100).toFixed(1)}%`,
  }
  console.log(
    `${input.name}: off ${off.toFixed(2)}ms  on ${on.toFixed(2)}ms  overhead ${((on / off - 1) * 100).toFixed(1)}%`,
  )
}

mkdirSync(join(root, 'bench/results'), { recursive: true })
writeFileSync(join(root, 'bench/results/trace.json'), JSON.stringify(out, null, 2))
console.log('raw json: bench/results/trace.json')
