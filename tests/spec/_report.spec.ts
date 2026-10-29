import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render } from '../../src/api'

// dev-only aggregate reporter: prints failing example numbers, sections and
// diffs so the fixture-driven fix loop doesn't require 652 vitest lines.
// run: npm run spec:report

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/commonmark-0.31.2.json'), 'utf8'),
) as { example: number; section: string; markdown: string; html: string }[]

describe('spec report', () => {
  it('all examples pass', () => {
    const failures: string[] = []
    for (const ex of spec) {
      let got: string
      try {
        got = render(ex.markdown)
      } catch (err) {
        const message = err instanceof Error ? err.stack : String(err)
        failures.push(
          `#${ex.example} [${ex.section}] THREW\n  input: ${JSON.stringify(ex.markdown)}\n  ${('' + message).split('\n').slice(0, 4).join('\n  ')}`,
        )
        continue
      }
      if (got !== ex.html) {
        failures.push(
          `#${ex.example} [${ex.section}]\n  input:    ${JSON.stringify(ex.markdown)}\n  expected: ${JSON.stringify(ex.html)}\n  got:      ${JSON.stringify(got)}`,
        )
      }
    }
    if (failures.length > 0) {
      console.log(`\n=== ${failures.length}/${spec.length} failing ===\n`)
      console.log(failures.slice(0, 30).join('\n\n'))
      if (failures.length > 30) console.log(`\n... and ${failures.length - 30} more`)
    }
    expect(failures, `${failures.length} spec failures`).toEqual([])
  })
})
