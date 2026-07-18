import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const failures = []

const requiredScripts = [
  'build',
  'check',
  'test',
  'test:contract',
  'test:core',
  'test:coverage',
  'test:live',
  'test:package',
  'test:system',
  'typecheck',
]

for (const script of requiredScripts) {
  if (!manifest.scripts?.[script]) failures.push(`package.json is missing scripts.${script}`)
}

const vitestRange = manifest.devDependencies?.vitest ?? manifest.dependencies?.vitest
// WHY the major must be anchored at the start of the declared range: searching
// for any standalone "4" also accepts ranges such as ^3.4.0 and ^2.1.4. The
// repositories use ordinary npm range prefixes, so accepting only an optional
// comparator followed by major 4 makes this gate strict without adding a
// production dependency solely to inspect one pinned dev-tool version.
const usesVitest4 =
  typeof vitestRange === 'string' &&
  /^\s*(?:\^|~|>=?|=)?\s*4(?:\.|$)/.test(vitestRange)
if (!usesVitest4) {
  failures.push(`vitest must use major version 4; received ${JSON.stringify(vitestRange)}`)
}

if (manifest.scripts?.test === manifest.scripts?.['test:live']) {
  failures.push('test and test:live must not resolve to the same command')
}

const ignoredDirectories = new Set([
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'third_party',
  'vendor',
])

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(path)
      continue
    }

    if (!['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(extname(entry.name))) continue
    if (!/(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue

    const source = await readFile(path, 'utf8')
    if (/\b(?:describe|it|test)\.only\s*\(/.test(source)) {
      failures.push(`${relative(root, path)} contains a focused test`)
    }
  }
}

await visit(root)

if (failures.length > 0) {
  console.error('Test contract violations:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Test contract satisfied for ${manifest.name ?? relative(root, root)}`)
}
