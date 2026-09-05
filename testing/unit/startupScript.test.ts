import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('production startup pipeline', () => {
  it('requires a successful full build before launching without a redundant preview build', () => {
    // WHY this is a manifest contract: electron-vite preview builds by default,
    // even if npm has just built all three targets. Removing build:app instead
    // would lose remote-client and packaged resource/helper preparation. The
    // conjunction also prevents launching stale output after a failed build.
    const stages = scripts.start.split(/\s*&&\s*/)
    expect(stages).toHaveLength(2)
    expect(stages[0]).toBe('npm run build:app')
    const launch = stages[1].trim().split(/\s+/)
    expect(launch.slice(0, 2)).toEqual(['electron-vite', 'preview'])
    expect(launch).toContain('--skipBuild')
  })
})
