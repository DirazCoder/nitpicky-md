import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render } from '../../src/api'

// gfm extension examples extracted from cmark-gfm's spec.txt. extension
// sections only: the gfm spec's core sections are based on commonmark 0.29
// and disagree with 0.31.2 in places, so running them would test 0.29.

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(
  readFileSync(join(here, '../../tests/fixtures/gfm-extensions.json'), 'utf8'),
) as {
  section: string
  extension: string
  markdown: string
  html: string
}[]

describe('GFM extension spec', () => {
  for (const ex of spec) {
    it(`[${ex.extension}] ${JSON.stringify(ex.markdown).slice(0, 50)}`, () => {
      // cmark-gfm's spec.txt html blocks don't carry the trailing newline the
      // commonmark spec.json does; normalize one away on both sides
      const strip = (x: string): string => x.replace(/\n$/, '')
      expect(strip(render(ex.markdown, { dialect: 'gfm' }))).toBe(strip(ex.html))
    })
  }
})
