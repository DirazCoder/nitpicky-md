# nitpicky-md

A markdown parser that tells you when your markdown almost worked.

CommonMark 0.31.2 + GFM compliant, fully positioned AST, zero runtime
dependencies. On top of the spec-correct parse you get three things:

- **near-miss diagnostics** — `*bold*` with no closing `*`, a fence that never
  closes, `#Heading` missing its space, a `[link](` that falls apart: flagged
  with source positions and, where the fix is mechanical, the edit itself
- **parse provenance** — `explain()` answers _why is this text what it is_:
  the rule that produced it, the spec section, and the alternatives the
  parser rejected at that exact spot
- **cross-dialect divergence** — `compare()` runs the same document through
  our CommonMark/GFM profiles plus any engines you inject (markdown-it,
  marked, …) and reports structural differences mapped to source ranges, with
  a CI mode

## Install

```
npm install nitpicky-md
```

ESM-only, Node 20+. The library entry is browser-safe (no Node builtins —
enforced in CI); only the CLI uses `node:fs` and friends.

## The three features, quickly

**Diagnostics.** They come from the parser's own rejected decisions — the
same code that decided your `**` doesn't close anything knows it _almost_
did. Nothing re-scans the document with regexes.

```js
import { analyze } from 'nitpicky-md'

const { diagnostics } = analyze(readmeText, { dialect: 'gfm' })
// 41:1 error atx-missing-space: heading needs a space between the #s and the text
//    fix: insert ' ' at 41:2
```

**Provenance.** Every AST node records the rule that produced it. `explain`
pairs that with the decision trace:

```
$ nitpicky-md explain doc.md:3:14
3:14 (offset 26)
  plain text; from §6 Inlines; not link: the (...) part did not parse as destination + title
  path: document > paragraph > text
  rule: text (§6, https://spec.commonmark.org/0.31.2/#inlines)
  tried link: rejected -- the (...) part did not parse as destination + title (CommonMark 0.31.2 §6.6)
  tried atx-heading: rejected -- no # characters start the line (CommonMark 0.31.2 §4.2)
```

**Divergence.** `www.example.com` is plain text in CommonMark and a link in
GFM; `~~strike~~` only exists in GFM. If your docs render differently
somewhere else, this finds where:

```
$ nitpicky-md check docs/ --targets commonmark,gfm --fail-on-diff
docs/README.md: nitpicky/commonmark vs nitpicky/gfm [4..19): autolink vs text
```

Each of these is a tested example — see `examples/` (run against the built
package by the test suite, so they can't rot).

## API

```js
import { parse, render, analyze, explain, compare, gfmProfile } from 'nitpicky-md'
```

### parse / render

```js
const doc = parse('# hello', { dialect: 'gfm' })
render('# hello') // '<h1>hello</h1>\n'
```

`parse` returns the AST (a `document` node). Every node carries:

- `type` — the node kind, e.g. `heading`, `emphasis`, `table-row`
- `rule` — the producing rule, e.g. `atx-heading`, `setext-heading` — this is
  the provenance hook: `explain()` and the trace are keyed on it
- `span: { start, end }` — source positions of what the node covers

Positions (`offset`, `line`, `column`):

- `line` is 1-based, `column` is 1-based **code points**, tabs count as one
  column. That matches what editors report for a cursor; the spec's
  tab-advances-to-next-multiple-of-4 arithmetic is internal to block
  structure decisions.
- offsets point into the **normalized** document: `\r\n` and lone `\r`
  become `\n`, NUL becomes U+FFFD (spec appendix; cmark does the same).
  Line/column numbers still match the original file.

Escapes (`\*`), entities (`&amp;`), and link reference definitions are kept
as distinct AST nodes instead of being folded away, so provenance can point
at them.

Options: `{ dialect: 'commonmark' | 'gfm' }` (default `commonmark`), and
`{ trace: true }` for the decision stream described under [Trace](#trace).

### analyze — near-miss diagnostics

```js
const { document, diagnostics } = analyze(md, { dialect: 'gfm' })
```

Each diagnostic: stable `code`, `severity` (`error`/`warn`/`info`), `message`,
`span`, and — where the fix is mechanical — a `fix: { start, end, replacement }`
edit in normalized-document offsets.

The rules:

| code                           | severity | fires when                                                                                                                    |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `link-reference-undefined`     | error    | double-bracket link shapes (`[[label]](url)`, `[text][missing]`) where the inner bracket never resolves and renders literally |
| `emphasis-unclosed`            | warn     | `**`/`__` opener with no closer (`**bold*` leaves a stray `*`)                                                                |
| `fence-unclosed`               | error    | fenced code block that runs to the end of its container                                                                       |
| `fence-close-wrong-char`       | error    | closing fence uses a different character than the opening one                                                                 |
| `atx-missing-space`            | error    | `#Heading` — 1-6 hashes glued to text (only outside paragraphs: `#fragment` url lines are left alone)                         |
| `table-delimiter-malformed`    | error    | pipe-and-dash row that fails the delimiter grammar                                                                            |
| `table-cell-count-mismatch`    | error    | delimiter row cell count differs from the header row                                                                          |
| `raw-html-malformed`           | warn     | `<tag ...` that fails the raw HTML grammar and renders literally (TypeScript generics in prose are excluded)                  |
| `link-inline-malformed`        | error    | `](...)` found but no complete destination/title/`)` follows                                                                  |
| `list-interrupt-needs-start-1` | info     | `2. item` after a paragraph: ordered lists can only interrupt starting at 1                                                   |

Some plausible rules were deliberately left out because they fire on
intentional text: unclosed single-backtick "code spans" (lone backticks are
quotes), bare `[bracket]` references (`dp[i][j]`, `[NB ...]` — only
double-bracket shapes fire), `~` strikethrough (`~10x`, `~/.config` are
literals), short closing fences (READMEs legitimately document nested
fences). A diagnostic you learn to ignore is worse than no diagnostic;
precision beats recall here.

### explain — parse provenance

```js
const explanation = explain(md, { line: 3, column: 14 })
// or: explain(md, 26) for an offset
formatExplanation(explanation) // human-readable multi-line report
```

Returns the deepest node covering the position, the path to it, the rule +
spec section that produced it, accepted decisions touching the span, and the
alternatives the parser rejected there — with reasons and spec citations.
The worked cases (nested links, the three-rule emphasis cases, lazy
continuation, setext vs thematic break, …) live in
`tests/explain/explain-cases.spec.ts`.

### compare — cross-engine divergence

```js
import { compare, commonmarkProfile, gfmProfile } from 'nitpicky-md'

const report = compare(md, [gfmProfile, myEngine])
```

Engines are **injected**: `{ name, render(md) => html }`. We ship
`commonmarkProfile` and `gfmProfile` (ourselves); anything else you construct
from whatever parser you already have installed. The library never imports
another markdown package — that's the zero-dependency trade-off, and it's
why the CLI loads engines from _your_ node_modules at runtime.

Divergences are structural (normalized token trees, never string diffs) and
carry source ranges whenever one side is one of our profiles; when both
sides are injected engines, ranges are absent — we won't guess.

The normalizer is its own small lexer (no dependencies). What it forgives,
because renderers legitimately disagree and it never matters: tag case,
comments, attribute order, boolean-attribute spelling, void-tag spelling
(`<br />` = `<br>`), entity encoding (`&amp;` = `&#38;`), whitespace-only
text between tags, trimmed text edges outside pre-ish elements, adjacent
text nodes, and GFM table alignment spellings. What it does **not** forgive:
percent-encoding differences in `href`/`src` (`ä` vs `%C3%A4` counts as a
divergence — renderers that re-encode URLs differently will show up, and
that's information, not noise).

The rules are validated the hard way: our commonmark profile vs markdown-it
and vs commonmark.js over all 652 spec examples must produce **zero**
divergences. Two spec-passing engines have to normalize to identical trees;
if they don't, a normalization rule is wrong.

### Trace

```js
parseFull(md, { trace: true }).internals.trace
```

The decision stream explain() is built on: `{ construct, phase, verdict,
reason?, start?, end?, spec? }` per accepted/rejected attempt. Off by
default; when off, the parser runs the identical code path with no recorder
and allocates no event objects, and the AST is byte-identical either way
(both tested).

## CLI

```
nitpicky-md render <file.md> [--gfm]          # html
nitpicky-md ast <file.md> [--gfm]             # AST as json
nitpicky-md explain <file.md>:<line>:<col>    # why did this parse this way
nitpicky-md analyze <file.md> [--gfm]         # near-miss diagnostics (exit 1 on errors)
nitpicky-md check <dir> --targets commonmark,gfm,markdown-it --fail-on-diff
```

`check`'s engine targets: `commonmark` and `gfm` are ours, built in. Anything
else loads from **your** project's node_modules at runtime. That's the
zero-dependency trade-off made explicit: we never import another markdown
package, so you bring the comparator you care about (`npm i -D markdown-it`)
and we error clearly if it's missing.

Exit codes: 0 clean, 1 divergence (`--fail-on-diff`) or error-severity
diagnostics (`analyze`), 2 usage/environment errors. `nitpicky` is installed
as an alias of `nitpicky-md`.

## Spec compliance

- 652/652 CommonMark 0.31.2 examples (`tests/spec/commonmark.spec.ts`)
- 23/23 GFM extension examples from cmark-gfm's spec — tables, task lists,
  strikethrough, autolink literals (`tests/spec/gfm.spec.ts`) — plus 28
  supplementary cases from the GFM spec prose and cmark-gfm/micromark
  behavior, including the edges where the spec text and the reference
  implementation disagree (`tests/spec/gfm-extra.spec.ts`)
- pathological inputs stay linear (adversarial suite, `tests/unit/adversarial.spec.ts`)
- fuzz: no crashes, no hangs, structural invariants hold on arbitrary input
  (2,000 cases per CI run, 100k via `npm run fuzz`)
- every node carries exact `offset`/`line`/`column`, verified over the whole
  spec corpus (`tests/unit/shape.spec.ts`)

Run it yourself: `npm ci && npm run spec:report`.

## Performance

We are **2–3x slower than commonmark.js and markdown-it** on ordinary
documents (roughly 17ms vs 6–8ms for the 98 KB spec text, parse + render,
on a 2-core container). The positions that provenance and diagnostics are
built on cost object allocations commonmark.js doesn't make. `npm run bench`
regenerates the comparison against commonmark.js / markdown-it / marked /
micromark and prints raw numbers; no tuning, no cherry-picked inputs. If you
need maximum throughput and don't need positions, use commonmark.js or
markdown-it.

The opt-in trace adds ~1% parse time when on; when off it's free — the
identical code path runs with no recorder and no event allocations.

## Similar tools

- **markdownlint** enforces style over accepted documents with line-based
  rules; it structurally can't see unclosed emphasis (emphasis spans lines
  within a paragraph) or anything that needs the parser's rejected
  decisions. Side by side on a 509-file corpus of real READMEs, our tuned
  rule set emitted 51 diagnostics where markdownlint's default config emitted
  62,624 findings (mostly line-length and inline-HTML style rules). Different
  tools, different jobs.
- **remend / Streamdown** detect unclosed markdown to silently _repair_ it
  for LLM streaming rendering. No diagnostics, no positions, no author-facing
  output.
- **Babelmark3** compares implementations in a browser, one input at a time,
  human-eyeball diff. No library form, no CI mode, no source ranges.

## Limitations

- offsets point into the normalized document (`\r\n` → `\n`) — line and
  column numbers match the original file, byte offsets don't on CRLF inputs
- label matching uses `toLowerCase()`, not full Unicode case folding (all
  spec examples pass; final-sigma edge cases remain)
- diagnostics favor precision over recall (see the deliberate omissions above)
- GFM's tagfilter extension is out of scope; raw HTML renders like CommonMark

## Development

```
npm ci
npm run typecheck && npm run lint && npm test
npm run check:deps      # zero-dependency gate (declared deps + dist imports + pack contents)
npm run bench           # performance comparison, prints a table
```

## License

MIT
