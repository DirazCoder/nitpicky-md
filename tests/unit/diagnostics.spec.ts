import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/api'

// one positive and one negative per rule. negatives matter as much here:
// a near-miss rule that fires on intentional text is a false positive.

function codes(md: string): string[] {
  return analyze(md, { dialect: 'gfm' }).diagnostics.map((d) => d.code)
}

describe('near-miss diagnostics', () => {
  it('atx-missing-space', () => {
    expect(codes('#Heading')).toContain('atx-missing-space')
    expect(codes('# Heading')).toEqual([])
  })

  it('atx-missing-space fix inserts the space', () => {
    const d = analyze('#Heading').diagnostics[0]
    expect(d?.fix).toEqual({ start: 1, end: 1, replacement: ' ' })
  })

  it('emphasis-unclosed on mixed delimiters, not on intraword or code', () => {
    expect(codes('**bold*')).toContain('emphasis-unclosed')
    expect(codes('snake_case_name')).toEqual([])
    expect(codes('`snake_case_name`')).toEqual([])
    expect(codes('2 * 3 * 4')).toEqual([])
  })

  it('link-inline-malformed', () => {
    expect(codes('[foo](bar')).toContain('link-inline-malformed')
    expect(codes('[foo](bar)')).toEqual([])
  })

  it('link-reference-undefined', () => {
    expect(codes('[foo][bar]')).toContain('link-reference-undefined')
    expect(codes('[foo][bar]\n\n[bar]: /url')).toEqual([])
    // a defined shortcut must not flag
    expect(codes('[foo]\n\n[foo]: /url')).toEqual([])
  })

  it('fence-unclosed', () => {
    expect(codes('```\ncode')).toContain('fence-unclosed')
    expect(codes('```\ncode\n```')).toEqual([])
  })

  it('fence-close-wrong-char', () => {
    expect(codes('```\nx\n~~~')).toContain('fence-close-wrong-char')
  })

  it('table-delimiter-malformed and cell-count mismatch', () => {
    expect(codes('| a | b |\n| -- x | --- |')).toContain('table-delimiter-malformed')
    expect(codes('| a | b |\n| --- |')).toContain('table-cell-count-mismatch')
    expect(codes('| a | b |\n| --- | --- |')).toEqual([])
  })

  it('list-interrupt-needs-start-1', () => {
    expect(codes('foo\n2. bar')).toContain('list-interrupt-needs-start-1')
    expect(codes('foo\n1. bar')).toEqual([])
  })

  it('precision gates hold', () => {
    // github alerts, code notation, reST citations, bare prose brackets
    expect(codes('> [!NOTE]\n> hi')).toEqual([])
    expect(codes('axios(url[, config])')).toEqual([])
    expect(codes('see [for Ludwig]_ now')).toEqual([])
    expect(codes('dp[i][j] denotes the distance')).toEqual([])
    expect(codes('see [Windows] support')).toEqual([])
    // but real double-bracket errors still fire
    expect(codes('[[*Live*]](https://example.com)')).toContain('link-reference-undefined')
    expect(codes('[docs][./docs]')).toContain('link-reference-undefined')
  })

  it('raw-html-malformed', () => {
    expect(codes('a <div class= foo')).toContain('raw-html-malformed')
    expect(codes('a <div class="x"> b')).toEqual([])
    // typescript generics in prose are not tag attempts
    expect(codes('returns <WithFaceDetection<{}>> objects')).toEqual([])
  })

  it('diagnostics carry precise spans', () => {
    const d = analyze('x\n\n#Heading').diagnostics[0]
    expect(d?.span.start.line).toBe(3)
    expect(d?.span.start.column).toBe(1)
  })
})
