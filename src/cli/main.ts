// cli entry. the only place node builtins are allowed (check-deps.mjs
// enforces the split). subcommands grow per phase: render | ast | explain | check
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  render,
  parse,
  explain,
  formatExplanation,
  analyze as analyzeImport,
  compare,
  commonmarkProfile,
  gfmProfile,
} from '../api'
import type { Engine } from '../api'

interface Args {
  command: string
  file?: string | undefined
  dialect: 'commonmark' | 'gfm'
}

function usage(): string {
  return [
    'nitpicky-md — a markdown parser that tells you when your markdown almost worked',
    '',
    'usage:',
    '  nitpicky-md render <file.md> [--gfm]            print html',
    '  nitpicky-md ast <file.md> [--gfm]               print the AST as json',
    '  nitpicky-md explain <file.md>:<line>:<col>      why did this text parse this way',
    '  nitpicky-md analyze <file.md> [--gfm]           near-miss diagnostics',
    '  nitpicky-md check <dir-or-file> [--targets a,b] [--fail-on-diff]',
    '                                                  cross-engine divergence check',
    '',
    'options:',
    '  --gfm    use the gfm dialect (tables, task lists, strikethrough, autolinks)',
  ].join('\n')
}

function parseArgs(argv: readonly string[]): Args {
  let dialect: 'commonmark' | 'gfm' = 'commonmark'
  const positional: string[] = []
  for (const a of argv) {
    if (a === '--gfm') dialect = 'gfm'
    else if (a === '--help' || a === '-h') {
      process.stdout.write(usage() + '\n')
      process.exit(0)
    } else positional.push(a)
  }
  const command = positional[0] ?? ''
  const file = positional[1]
  return { command, file, dialect }
}

/** `file.md:12:5` -> {file, line, column} */
function parseFilePosition(
  arg: string,
): { file: string; line: number; column: number } | { file: string } {
  const m = /^(.+):(\d+):(\d+)$/.exec(arg)
  if (!m) return { file: arg }
  return { file: m[1] ?? arg, line: Number(m[2]), column: Number(m[3]) }
}

/**
 * resolve a --targets list into engines. commonmark/gfm are ours; anything
 * else is dynamically imported from the user's own node_modules, because the
 * published package has zero dependencies and that's not negotiable.
 */
async function resolveEngines(names: readonly string[]): Promise<Engine[]> {
  const engines: Engine[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name === '') continue
    if (name === 'commonmark') {
      engines.push(commonmarkProfile)
      continue
    }
    if (name === 'gfm') {
      engines.push(gfmProfile)
      continue
    }
    try {
      // resolve through require semantics (package.json main/exports) from
      // the user's cwd, then import the file -- ESM can't import a directory
      const req = createRequire(join(process.cwd(), 'package.json'))
      const resolved = req.resolve(name)
      const mod = (await import(pathToFileURL(resolved).href)) as {
        default?: unknown
      } & Record<string, unknown>
      // every engine packages differently: markdown-it's default is a
      // constructor, marked exports { marked }, micromark exports
      // { micromark }. take whichever callable we can find.
      const candidate =
        mod.default ??
        (typeof mod.marked === 'function'
          ? mod.marked
          : typeof mod.micromark === 'function'
            ? (mod.micromark as (md: string, opts?: unknown) => string)
            : mod)
      const renderFn =
        typeof candidate === 'function'
          ? (candidate as (md: string) => string)
          : typeof (candidate as { render?: unknown }).render === 'function'
            ? (candidate as { render: (md: string) => string }).render
            : typeof mod.markdownit === 'function'
              ? null
              : undefined
      if (renderFn === null) continue
      if (renderFn === undefined) {
        // markdown-it style: default export is a constructor
        const ctor = candidate as new (
          preset?: string,
          opts?: unknown,
        ) => { render: (md: string) => string }
        try {
          const instance = new ctor('commonmark', { html: true })
          engines.push({ name, render: (md: string) => instance.render(md) })
          continue
        } catch {
          // fall through to the error
        }
        throw new Error(`can't build a (markdown: string) => string engine from ${name}`)
      }
      // marked-style: callable; markdown-it callable returns a renderer
      try {
        const out = renderFn('# hi')
        if (typeof out === 'string' && out.includes('<')) {
          engines.push({ name, render: renderFn })
          continue
        }
      } catch {
        // callable but needs options; try the constructor path
      }
      const ctor = candidate as new (
        preset?: string,
        opts?: unknown,
      ) => { render: (md: string) => string }
      const instance = new ctor('commonmark', { html: true })
      engines.push({ name, render: (md: string) => instance.render(md) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `can't load engine "${name}": ${message}. it isn't built in -- install it in your project (npm i -D ${name}) or drop it from --targets. this is the zero-dependency trade-off: engines are loaded from YOUR node_modules at runtime.`,
        { cause: err },
      )
    }
  }
  return engines
}

function collectMarkdownFiles(target: string): string[] {
  const stat = statSync(target, { throwIfNoEntry: false })
  if (!stat) {
    process.stderr.write(`no such file or directory: ${target}
`)
    process.exit(2)
  }
  if (stat.isFile()) return [target]
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue
        walk(full)
      } else if (/\.(md|markdown)$/i.test(entry)) {
        out.push(full)
      }
    }
  }
  walk(target)
  return out.sort()
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv)
  const target =
    argv.find((a) => !a.startsWith('-') && a !== args.command && a !== args.file) ?? args.file ?? ''
  if (args.command === 'explain') {
    const { file, ...lineCol } = parseFilePosition(target)
    if (!('line' in lineCol)) {
      process.stderr.write('explain needs file.md:line:column\n')
      process.exit(2)
    }
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`can't read ${file}: ${message}\n`)
      process.exit(2)
    }
    const result = explain(
      source,
      { line: lineCol.line, column: lineCol.column },
      { dialect: args.dialect },
    )
    process.stdout.write(formatExplanation(result) + '\n')
    return
  }
  if (args.command === 'analyze') {
    let source: string
    try {
      source = readFileSync(args.file ?? '', 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`can't read ${args.file ?? ''}: ${message}\n`)
      process.exit(2)
    }
    const { diagnostics } = analyzeImport(source, { dialect: args.dialect })
    if (diagnostics.length === 0) {
      process.stdout.write('no near-miss diagnostics\n')
      return
    }
    let bad = 0
    for (const d of diagnostics) {
      process.stdout.write(
        `${d.span.start.line}:${d.span.start.column} ${d.severity} ${d.code}: ${d.message}\n`,
      )
      if (d.severity === 'error') bad++
    }
    process.exitCode = bad > 0 ? 1 : 0
    return
  }
  if (args.command === 'check') {
    void runCheck(argv)
    return
  }
  if (args.command !== 'render' && args.command !== 'ast') {
    process.stderr.write(`unknown command: ${args.command}\n${usage()}\n`)
    process.exit(2)
  }
  let source: string
  try {
    source = readFileSync(args.file ?? '', 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`can't read ${args.file ?? ''}: ${message}\n`)
    process.exit(2)
  }
  if (args.command === 'render') {
    process.stdout.write(render(source, { dialect: args.dialect }))
    return
  }
  process.stdout.write(JSON.stringify(parse(source, { dialect: args.dialect }), null, 2) + '\n')
}

main()

async function runCheck(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith('-'))
  const target = positional[1]
  const targetsIdx = argv.indexOf('--targets')
  const targetsArg = targetsIdx !== -1 ? (argv[targetsIdx + 1] ?? '') : 'commonmark,gfm'
  const failOnDiff = argv.includes('--fail-on-diff')
  if (!target) {
    process.stderr.write('check needs a file or directory\n')
    process.exit(2)
  }
  let engines: Engine[]
  try {
    engines = await resolveEngines(targetsArg.split(','))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`)
    process.exit(2)
  }
  if (engines.length < 2) {
    process.stderr.write('check needs at least two targets to compare\n')
    process.exit(2)
  }
  const files = collectMarkdownFiles(target)
  let totalDiffs = 0
  for (const file of files) {
    let md: string
    try {
      md = readFileSync(file, 'utf8')
    } catch (err) {
      process.stderr.write(
        `can't read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(2)
    }
    const report = compare(md, engines)
    if (report.divergences.length > 0) {
      totalDiffs += report.divergences.length
      for (const d of report.divergences) {
        const range = d.span ? ` [${d.span.start}..${d.span.end})` : ''
        process.stdout.write(
          `${file}: ${d.engines[0]} vs ${d.engines[1]}${range}: ${d.description}\n`,
        )
      }
    }
  }
  if (totalDiffs === 0) {
    process.stdout.write(
      `no divergence across ${files.length} file(s) and ${engines.length} targets\n`,
    )
    return
  }
  process.stdout.write(`${totalDiffs} divergence(s) across ${files.length} file(s)\n`)
  if (failOnDiff) process.exit(1)
}
