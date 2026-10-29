import type { NearMiss } from './trace'
import { normalizeSource, positionAt } from './normalize'

// near-miss diagnostics. everything here derives from the parser's own
// rejected decisions (see trace.ts) -- nothing re-scans the document.
// severity policy:
//   error = the syntax you wrote almost certainly didn't do what you meant
//   warn  = probably not what you meant, but plausible as literal text
//   info  = fine as literal, mentioning it bcz it's a common authoring slip

export interface Diagnostic {
  /** stable machine code, e.g. 'fence-unclosed' */
  readonly code: string
  readonly severity: 'error' | 'warn' | 'info'
  readonly message: string
  /** span of the offending source */
  readonly span: { start: Position; end: Position }
  /** an edit that fixes it, when one is unambiguous */
  readonly fix?: Fix
}

export interface Fix {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

export interface Position {
  readonly offset: number
  readonly line: number
  readonly column: number
}
export type { Position as DiagnosticPosition }

interface Rule {
  severity: 'error' | 'warn' | 'info'
  message: (nm: NearMiss, end: Position) => string
  /** returns a fix when one is mechanical and safe */
  fix?: (nm: NearMiss) => Fix | undefined
}

const RULES: Record<string, Rule> = {
  'fence-unclosed': {
    severity: 'error',
    message: () => 'fenced code block never closes',
    fix: (nm) => ({ start: -1, end: -1, replacement: `\n${nm.detail ?? '```'}` }), // start filled by caller
  },
  'fence-close-wrong-char': {
    severity: 'error',
    message: () => 'closing fence uses a different character than the opening fence',
  },
  'atx-missing-space': {
    severity: 'error',
    message: () => 'heading needs a space between the #s and the text',
    fix: (nm) => ({ start: nm.offset + 1, end: nm.offset + 1, replacement: ' ' }),
  },
  'emphasis-unclosed': {
    severity: 'warn',
    message: (nm) => `unmatched ${nm.detail ?? '*'} delimiter: emphasis opened but never closed`,
  },
  'link-inline-malformed': {
    severity: 'error',
    message: () =>
      'link syntax is broken: `](` found but no complete destination/title/`)` follows',
  },
  'link-reference-undefined': {
    severity: 'error',
    // the emitter only fires this for double-bracket shapes (see
    // looksLikeReferenceAttempt); the message matches that reality
    message: () => 'double-bracket link: the inner bracket never resolves, so it renders literally',
  },
  'table-delimiter-malformed': {
    severity: 'error',
    message: () =>
      'table delimiter row is malformed: cells must be `---` with optional `:` alignment',
  },
  'table-cell-count-mismatch': {
    severity: 'error',
    message: (nm) =>
      `delimiter row doesn't match the header row (${nm.detail ?? 'cell counts differ'})`,
  },
  'list-interrupt-needs-start-1': {
    severity: 'info',
    message: () =>
      'only lists starting at 1 can interrupt a paragraph (hard-wrapped numbers stay text)',
  },
  'raw-html-malformed': {
    severity: 'warn',
    message: () => "this looks like an HTML tag but the syntax doesn't parse as one",
  },
}

/** dedupe key: same code at the same spot across paragraph reruns */
function key(nm: NearMiss): string {
  return `${nm.code}@${nm.offset}`
}

export function distillDiagnostics(nearMisses: readonly NearMiss[], source: string): Diagnostic[] {
  const doc = normalizeSource(source)
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const nm of nearMisses) {
    const k = key(nm)
    if (seen.has(k)) continue
    seen.add(k)
    const rule = RULES[nm.code]
    if (!rule) continue
    const start = positionAt(doc, nm.offset)
    const end = positionAt(doc, nm.offset + spanLength(nm))
    const diagnostic: {
      code: string
      severity: 'error' | 'warn' | 'info'
      message: string
      span: { start: Position; end: Position }
      fix?: Fix
    } = {
      code: nm.code,
      severity: rule.severity,
      message: rule.message(nm, end),
      span: { start, end },
    }
    if (rule.fix) {
      const raw = rule.fix(nm)
      let fix: Fix | undefined = raw
      if (nm.code === 'fence-unclosed' && raw) {
        // an unclosed fence swallows the rest of the document, so the fix is
        // appending the closing fence at the (normalized) source end
        fix = { start: doc.text.length, end: doc.text.length, replacement: raw.replacement }
      }
      if (fix !== undefined && fix.start >= 0) diagnostic.fix = fix
    }
    out.push(diagnostic)
  }
  return out.sort((a, b) => a.span.start.offset - b.span.start.offset)
}

/** how much source the diagnostic should highlight */
function spanLength(nm: NearMiss): number {
  switch (nm.code) {
    case 'fence-unclosed':
      return 3
    case 'atx-missing-space':
      return 1
    case 'fence-close-too-short':
      return (nm.detail ?? '```').length - 1
    default:
      return 1
  }
}
