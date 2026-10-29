// fails if the published package would have any runtime dependency, if
// anything in dist imports a non-relative path, or if the browser entry
// touches node builtins. run: npm run check:deps
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failed = false
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  failed = true
}

// 1. no runtime dependencies of any kind
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const deps = pkg[field]
  if (deps !== undefined && Object.keys(deps).length > 0) {
    fail(`${field} is non-empty: ${JSON.stringify(deps)}`)
  }
}

// 2. built output imports only relative paths; browser entry has no node
// builtins; cli entry may use node builtins only
const dist = join(root, 'dist')
if (!existsSync(dist)) {
  fail('dist/ does not exist -- run npm run build first')
} else {
  const importRe = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
  for (const file of readdirSync(dist)) {
    if (!file.endsWith('.js')) continue
    const js = readFileSync(join(dist, file), 'utf8')
    let m
    while ((m = importRe.exec(js)) !== null) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('#')) continue
      const isNode = spec.startsWith('node:') || spec === 'node'
      if (file === 'cli.mjs') {
        if (!isNode)
          fail(`dist/${file} imports non-relative "${spec}" (cli may only use node builtins)`)
      } else {
        fail(`dist/${file} imports non-relative "${spec}" -- the package is zero-dependency`)
      }
    }
  }
}

// 3. bin entries exist and are executable-ish (shebang or not, node runs them)
for (const binPath of Object.values(pkg.bin ?? {})) {
  if (!existsSync(join(root, binPath))) fail(`bin target ${binPath} missing from dist`)
}

if (failed) process.exit(1)
console.log('deps ok: zero runtime dependencies, dist imports clean')
