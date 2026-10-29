import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// examples must run against the built package and say something true.
// run: npm run build && npm test -- tests/examples

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')

function runExample(name: string): string {
  return execFileSync('node', [join(root, 'examples', name)], { encoding: 'utf8' })
}

describe('examples', () => {
  it('diagnostics example produces the expected diagnostics', () => {
    const out = runExample('diagnostics.example.mjs')
    expect(out).toContain('link-inline-malformed')
    expect(out).toContain('link-reference-undefined')
    expect(out).toContain('emphasis-unclosed')
    expect(out).toContain('table-cell-count-mismatch')
    // www.commonmark.org is a link under gfm, so it must NOT flag
    expect(out).not.toContain('www.commonmark.org')
  })

  it('provenance example explains both positions', () => {
    const out = runExample('provenance.example.mjs')
    expect(out).toContain('tried link: rejected')
    expect(out).toContain('atx-heading')
    expect(out).toContain('§4.2')
  })

  it('divergence example finds www + strikethrough divergence', () => {
    const out = runExample('divergence.example.mjs')
    expect(out).toContain('nitpicky/commonmark vs nitpicky/gfm')
    expect(out).toContain('www.commonmark.org')
  })
})
