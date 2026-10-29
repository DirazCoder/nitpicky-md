// npm pack --dry-run, then assert only the allowed files ship.
// run: npm run check:pack
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let packed
try {
  // shell: true because npm is npm.cmd on windows and node refuses to spawn
  // .cmd files without a shell
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  })
  // npm prints the json array; older versions prefix a tar notice line
  const start = out.indexOf('[')
  packed = JSON.parse(out.slice(start))
} catch (err) {
  console.error('FAIL: npm pack --dry-run failed', err instanceof Error ? err.message : err)
  process.exit(1)
}

const ALLOW = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'])
const allowed = (p) => ALLOW.has(p) || p.startsWith('dist/')

let failed = false
for (const entry of packed[0]?.files ?? []) {
  if (!allowed(entry.path)) {
    console.error(
      `FAIL: ${entry.path} would ship but isn't in the allowlist (dist/, README, LICENSE, CHANGELOG, package.json)`,
    )
    failed = true
  }
}
const shipped = (packed[0]?.files ?? []).map((f) => f.path)
if (!shipped.some((p) => p.startsWith('dist/index.js'))) {
  console.error('FAIL: dist/index.js missing from the tarball')
  failed = true
}
if (!shipped.some((p) => p.startsWith('dist/cli.mjs'))) {
  console.error('FAIL: dist/cli.mjs missing from the tarball')
  failed = true
}
if (failed) process.exit(1)
console.log(
  `pack ok: ${shipped.length} files (${shipped.filter((p) => p.startsWith('dist/')).length} in dist/)`,
)
