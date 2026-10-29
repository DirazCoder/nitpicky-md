import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render } from '../../src/api'

// the whole point of the project: 652/652 against the official fixture.
// the aggregate reporter in _report.spec.ts is the iteration tool; this file
// is the CI-grade per-example suite.

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/commonmark-0.31.2.json'), 'utf8'),
) as { example: number; section: string; markdown: string; html: string }[]

describe('CommonMark 0.31.2 spec', () => {
  for (const ex of spec) {
    it(`example ${String(ex.example).padStart(3, ' ')} [${ex.section}]`, () => {
      expect(render(ex.markdown)).toBe(ex.html)
    })
  }
})
