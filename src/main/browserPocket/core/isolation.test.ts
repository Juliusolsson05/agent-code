import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Decomposition §3: core/ is pure. It is tested against recordings without an
// Electron runtime; an `electron` import here would make those tests
// impossible to run and pull I/O into the reconciliation layer.
it('core/ never imports electron or node I/O', () => {
  const dir = __dirname
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8')
    expect(src, file).not.toMatch(/from ['"](electron|node:child_process|node:fs|node:fs\/promises)['"]/)
  }
})
