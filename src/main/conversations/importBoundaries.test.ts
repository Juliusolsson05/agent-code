import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The catalog is the isolated hard part (docs/decomposition/conversations.md
// §4): pure, one consumer, data flowing one way. Same filesystem-scan shape as
// src/providers/importBoundaries.test.ts, for the same reason: visible in the
// suite, loud in CI, no new tooling.
const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '..', '..')

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...files(full)); continue }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}
const specifiers = (source: string) => [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]!)

describe('conversation catalog boundaries', () => {
  it('the catalog imports no I/O, no source implementation and no renderer', () => {
    // `sources/types.js` is the catalog's INPUT contract (SourceConversation)
    // and is type-only; every other sources module does I/O and is forbidden.
    for (const file of files(join(here, 'catalog'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^(node:)?(fs|fs\/promises|child_process|sqlite)$|sources\/(?!types\.js$)|@renderer|@main\/(ipc|sessionManager)|codex-headless|claude-code-headless|opencode-headless/)
      }
    }
  })
  it('sources never import the catalog, and the renderer never imports main conversations', () => {
    for (const file of files(join(here, 'sources'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) expect(spec, `${file} imports ${spec}`).not.toMatch(/catalog\//)
    }
    for (const file of files(join(srcRoot, 'renderer'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) expect(spec, `${file} imports ${spec}`).not.toMatch(/@main\/conversations|main\/conversations/)
    }
  })
})
