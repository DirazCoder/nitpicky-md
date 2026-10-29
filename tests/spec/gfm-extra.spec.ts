import { describe, expect, it } from 'vitest'
import { render } from '../../src/api'

// supplementary GFM cases beyond the 23 cmark-gfm spec examples, from the
// GFM spec prose and verified against cmark-gfm/micromark behavior. where the
// two disagree, cmark-gfm (what GitHub runs) wins and the case says so.

describe('GFM tables: beyond the spec examples', () => {
  it('inline spans parse inside header cells', () => {
    expect(render('| *a* | `b` |\n| --- | --- |', { dialect: 'gfm' })).toBe(
      '<table>\n<thead>\n<tr>\n<th><em>a</em></th>\n<th><code>b</code></th>\n</tr>\n</thead>\n</table>\n',
    )
  })

  it('inline spans parse inside body cells', () => {
    expect(render('| a | b |\n| --- | --- |\n| [c](d) | ~~e~~ |', { dialect: 'gfm' })).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td><a href="d">c</a></td>\n<td><del>e</del></td>\n</tr>\n</tbody>\n</table>\n',
    )
  })

  it('left/center/right alignment markers', () => {
    expect(
      render('| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |', { dialect: 'gfm' }),
    ).toBe(
      '<table>\n<thead>\n<tr>\n<th align="left">l</th>\n<th align="center">c</th>\n<th align="right">r</th>\n<th>n</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td align="left">1</td>\n<td align="center">2</td>\n<td align="right">3</td>\n<td>4</td>\n</tr>\n</tbody>\n</table>\n',
    )
  })

  it('escaped pipes work in header and body', () => {
    expect(render('| a \\| b |\n| --- |\n| c \\| d |', { dialect: 'gfm' })).toBe(
      '<table>\n<thead>\n<tr>\n<th>a | b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>c | d</td>\n</tr>\n</tbody>\n</table>\n',
    )
  })

  it('cell count mismatch means no table at all', () => {
    expect(render('| a | b |\n| --- |\n| 1 | 2 |', { dialect: 'gfm' })).toBe(
      '<p>| a | b |\n| --- |\n| 1 | 2 |</p>\n',
    )
  })

  it('a table does not interrupt a paragraph', () => {
    // cmark-gfm/GitHub behavior: the pipe rows stay paragraph text; the GFM
    // spec is silent on interruption and micromark disagrees, but GitHub is
    // cmark-gfm, so that's the dialect we ship
    expect(render('paragraph text\n| a | b |\n| --- | --- |\n| 1 | 2 |', { dialect: 'gfm' })).toBe(
      '<p>paragraph text\n| a | b |\n| --- | --- |\n| 1 | 2 |</p>\n',
    )
  })

  it('tables work inside list items', () => {
    expect(render('- | a | b |\n  | --- | --- |\n  | 1 | 2 |', { dialect: 'gfm' })).toBe(
      '<ul>\n<li>\n<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n</li>\n</ul>\n',
    )
  })

  it('header-only table renders no tbody', () => {
    expect(render('| a | b |\n| --- | --- |', { dialect: 'gfm' })).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n</table>\n',
    )
  })

  it('pipes without outer delimiters still form a table', () => {
    expect(render('a | b\n--- | ---\n1 | 2', { dialect: 'gfm' })).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n',
    )
  })
})

describe('GFM task lists: beyond the spec examples', () => {
  it('uppercase X marks the item checked', () => {
    // spec prose: "Either an upper or lower case X means the task is completed"
    expect(render('- [X] done', { dialect: 'gfm' })).toBe(
      '<ul>\n<li><input checked="" disabled="" type="checkbox"> done</li>\n</ul>\n',
    )
  })

  it('marker without following space stays literal', () => {
    expect(render('- [x]nospace', { dialect: 'gfm' })).toBe('<ul>\n<li>[x]nospace</li>\n</ul>\n')
  })

  it('empty brackets are not a task marker', () => {
    expect(render('- [] not a task', { dialect: 'gfm' })).toBe(
      '<ul>\n<li>[] not a task</li>\n</ul>\n',
    )
  })

  it('bare marker still renders a checkbox', () => {
    // cmark-gfm accepts the marker at end of line; micromark keeps [ ] literal.
    // GitHub renders the checkbox, so we do too.
    expect(render('- [ ]', { dialect: 'gfm' })).toBe(
      '<ul>\n<li><input disabled="" type="checkbox"> </li>\n</ul>\n',
    )
  })

  it('task markers nest', () => {
    expect(render('- [x] a\n  - [ ] b', { dialect: 'gfm' })).toBe(
      '<ul>\n<li><input checked="" disabled="" type="checkbox"> a\n<ul>\n<li><input disabled="" type="checkbox"> b</li>\n</ul>\n</li>\n</ul>\n',
    )
  })
})

describe('GFM strikethrough: beyond the spec examples', () => {
  it('single tilde strikes', () => {
    // the spec prose says "two tildes" but cmark-gfm (extensions/strikethrough.c)
    // pairs one or two by default, micromark agrees with the code, and the code
    // is what GitHub runs -- we follow the implementation over the stale prose
    expect(render('~x~', { dialect: 'gfm' })).toBe('<p><del>x</del></p>\n')
  })

  it('intraword strikethrough works (tildes are not asterisks)', () => {
    expect(render('a~~b~~c', { dialect: 'gfm' })).toBe('<p>a<del>b</del>c</p>\n')
  })

  it('three or four tildes are fences, not strikethrough', () => {
    expect(render('~~~x~~~', { dialect: 'gfm' })).toBe(
      '<pre><code class="language-x~~~"></code></pre>\n',
    )
    expect(render('~~~~x~~~~', { dialect: 'gfm' })).toBe(
      '<pre><code class="language-x~~~~"></code></pre>\n',
    )
  })

  it('strikethrough wraps other emphasis', () => {
    expect(render('~~*a*~~', { dialect: 'gfm' })).toBe('<p><del><em>a</em></del></p>\n')
  })

  it('paragraph break kills the pairing', () => {
    // already in the spec examples; kept here because it's the flanking rule
    // people trip over most
    expect(render('a ~~b\n\nc~~ d', { dialect: 'gfm' })).toBe('<p>a ~~b</p>\n<p>c~~ d</p>\n')
  })
})

describe('GFM autolink literals: beyond the spec examples', () => {
  it('trailing punctuation is not part of the link', () => {
    expect(render('see www.google.com.', { dialect: 'gfm' })).toBe(
      '<p>see <a href="http://www.google.com">www.google.com</a>.</p>\n',
    )
  })

  it('balanced parentheses stay in the URL', () => {
    expect(render('(https://example.com/a(b))', { dialect: 'gfm' })).toBe(
      '<p>(<a href="https://example.com/a(b)">https://example.com/a(b)</a>)</p>\n',
    )
  })

  it('emails become mailto links', () => {
    expect(render('foo@bar.example.com', { dialect: 'gfm' })).toBe(
      '<p><a href="mailto:foo@bar.example.com">foo@bar.example.com</a></p>\n',
    )
  })

  it('underscores survive in http URLs', () => {
    expect(render('http://www.foo.com/bar_baz', { dialect: 'gfm' })).toBe(
      '<p><a href="http://www.foo.com/bar_baz">http://www.foo.com/bar_baz</a></p>\n',
    )
  })

  it('bare www is just text', () => {
    expect(render('www', { dialect: 'gfm' })).toBe('<p>www</p>\n')
  })

  it('enclosing punctuation is excluded', () => {
    expect(render('(see www.google.com)', { dialect: 'gfm' })).toBe(
      '<p>(see <a href="http://www.google.com">www.google.com</a>)</p>\n',
    )
  })

  it('code spans win over autolinking', () => {
    expect(render('`www.google.com`', { dialect: 'gfm' })).toBe(
      '<p><code>www.google.com</code></p>\n',
    )
  })

  it('explicit link text wins over the literal', () => {
    expect(render('[www.google.com](https://elsewhere.example)', { dialect: 'gfm' })).toBe(
      '<p><a href="https://elsewhere.example">www.google.com</a></p>\n',
    )
  })

  it('ports survive', () => {
    expect(render('https://example.com:8080/path', { dialect: 'gfm' })).toBe(
      '<p><a href="https://example.com:8080/path">https://example.com:8080/path</a></p>\n',
    )
  })
})
