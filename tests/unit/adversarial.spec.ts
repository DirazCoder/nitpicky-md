import { describe, expect, it } from 'vitest'
import { parse, render } from '../../src/api'

// adversarial inputs. the point isn't correctness of output (spec covers
// that), it's that parsing stays linear-ish and nothing blows up. npm run
// bench prints the actual growth ratios; here we just hold a generous
// ceiling so a quadratic regression fails CI loudly instead of hanging it.

function timed(fn: () => void): number {
  // min of 3: noise (GC pauses, runner contention) only ever inflates a run,
  // so the minimum tracks real cost. a single shot turned a linear parse
  // into a phantom x47 on CI when GC landed in the big run.
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    if (ms < best) best = ms
  }
  return best
}

const PATTERNS: { name: string; build: (n: number) => string }[] = [
  { name: 'nested emphasis', build: (n) => '*a '.repeat(n) + 'b' },
  { name: 'lone asterisk run', build: (n) => '*'.repeat(n) },
  { name: 'unclosed brackets', build: (n) => '[a'.repeat(n) },
  { name: 'nested brackets one close', build: (n) => '['.repeat(n) + 'a](/u)' },
  { name: 'many closed links', build: (n) => '[a](/u)'.repeat(n) },
  { name: 'backtick runs', build: (n) => '`x'.repeat(n) },
  { name: 'deep blockquotes', build: (n) => '> '.repeat(n) + 'x' },
  { name: 'deep list nesting', build: (n) => '  '.repeat(n) + '- x' },
  { name: 'huge table', build: (n) => '| a | b |\n| --- | --- |\n' + '| c | d |\n'.repeat(n) },
  {
    name: 'wide table row',
    build: (n) => '| ' + 'a | '.repeat(n) + 'b |\n| ' + '- | '.repeat(n) + '- |\n',
  },
  { name: 'link reference storm', build: (n) => '[x][y]\n\n' + '[y]: /u\n'.repeat(n) },
  { name: 'emphasis storm', build: (n) => '*a*'.repeat(n) },
]

describe('adversarial inputs parse without losing the plot', () => {
  for (const p of PATTERNS) {
    it(`${p.name}: linear-ish growth, no hang`, () => {
      const small = timed(() => {
        parse(p.build(2_000), { dialect: 'gfm' })
      })
      const big = timed(() => {
        parse(p.build(16_000), { dialect: 'gfm' })
      })
      // 8x input, generous 30x ceiling with an absolute floor: linear passes
      // easily, quadratic (64x) won't. tiny baselines make pure ratios noisy,
      // so anything under 100ms total is fine regardless.
      const ratio = big / Math.max(small, 0.01)
      const msg = `${p.name}: ${small.toFixed(1)}ms -> ${big.toFixed(1)}ms (x${ratio.toFixed(1)})`
      expect(big < 100 || ratio < 30, msg).toBe(true)
    })
  }

  it('100k deep blockquote renders (no stack overflow)', () => {
    const doc = '> '.repeat(100_000) + 'x'
    expect(() => render(doc)).not.toThrow()
  })

  it('100k nested emphasis renders (no stack overflow)', () => {
    const doc = '*'.repeat(100_000) + 'a' + '*'.repeat(100_000)
    expect(() => render(doc)).not.toThrow()
  })

  it('1MB single line parses', () => {
    const doc = 'a'.repeat(1_000_000)
    expect(timed(() => parse(doc))).toBeLessThan(2_000)
  })
})
