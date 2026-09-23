import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// Decomposition §3: placement has exactly two consumers. If a third file starts
// deciding where a guest is shown, the ownership bug class this layer exists to
// prevent comes back.
const RENDERER = join(__dirname, '../../../')
const ALLOWED = new Set([
  'features/browser-pocket/ui/BrowserPocketHost.tsx',
  'features/browser-pocket/ui/PocketSlot.tsx',
])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') yield* walk(path) }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path
  }
}

it('only the host and the slot import the placement layer', () => {
  const offenders: string[] = []
  for (const file of walk(RENDERER)) {
    const rel = relative(RENDERER, file).split('\\').join('/')
    if (rel.startsWith('features/browser-pocket/placement/')) continue
    if (/browser-pocket\/placement\//.test(readFileSync(file, 'utf8')) || (rel.startsWith('features/browser-pocket/') && /from '\.\.?\/?(\.\.\/)?placement\//.test(readFileSync(file, 'utf8')))) {
      if (!ALLOWED.has(rel)) offenders.push(rel)
    }
  }
  expect(offenders).toEqual([])
})
