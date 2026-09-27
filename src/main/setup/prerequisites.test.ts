import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// #1403 recheck a: when the check's tool-path write-back fails, the check
// still answers with what it probed. The toolchain must then launch what the
// check says it found, not the last persisted (possibly dead) path.
//
// The REAL check, toolchain and setup-state persistence in a scratch
// STATE_DIR. Replaced edges: the machine's shell/PATH probes and the bundled
// archives (machine-dependent). The failure is a real rename rejection.

const paths = vi.hoisted(() => ({ STATE_DIR: '' }))
vi.mock('@main/storage/paths.js', () => paths)
vi.mock('@main/setup/binaryResolver.js', () => ({
  resolveToolPath: async (tool: string) => (tool === 'codex' ? '/fresh/codex' : null),
  isExecutable: async (path: string) => path === '/fresh/codex',
  classifyExecutable: async () => 'ok',
}))
vi.mock('@main/setup/runtimeTools.js', () => ({
  isBundledArchiveAvailable: async () => false,
  resolveBundledTool: async () => null,
}))
const renameFaults = vi.hoisted(() => ({ failNext: 0 }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameFaults.failNext > 0) {
        renameFaults.failNext -= 1
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return await actual.rename(from, to)
    },
  }
})

let dir: string
const originalPath = process.env.PATH
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prerequisites-'))
  paths.STATE_DIR = dir
  renameFaults.failNext = 0
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await mkdir(dir, { recursive: true })
  // A codex that moved: the persisted path is gone, the probe finds a new one.
  await writeFile(join(dir, 'setup.json'), JSON.stringify({ version: 1, toolPaths: { codex: '/gone/codex' } }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.env.PATH = originalPath
  await rm(dir, { recursive: true, force: true })
})

it('launches what the check found when its write-back fails', async () => {
  const { checkPrerequisites } = await import('./prerequisites.js')
  const { getToolPath } = await import('./toolchain.js')
  renameFaults.failNext = 1
  const check = await checkPrerequisites()
  expect(check.tools.codex).toMatchObject({ found: true, path: '/fresh/codex' })
  // Not persisted...
  expect(JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')).toolPaths.codex).toBe('/gone/codex')
  // ...but what a launch uses in this process agrees with what the panel says.
  expect(getToolPath('codex', '')).toBe('/fresh/codex')
})

it('launches the persisted probe when the write-back lands', async () => {
  const { checkPrerequisites } = await import('./prerequisites.js')
  const { getToolPath } = await import('./toolchain.js')
  await checkPrerequisites()
  expect(JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')).toolPaths.codex).toBe('/fresh/codex')
  expect(getToolPath('codex', '')).toBe('/fresh/codex')
})
