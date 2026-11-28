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
const resolver = vi.hoisted(() => ({
  resolveToolPath: vi.fn(async (tool: string): Promise<string | null> => (tool === 'codex' ? '/fresh/codex' : null)),
  isExecutable: vi.fn(async (path: string): Promise<boolean> => path === '/fresh/codex'),
  classifyExecutable: vi.fn(async () => 'ok' as const),
}))
vi.mock('@main/setup/binaryResolver.js', () => resolver)
const runtimeTools = vi.hoisted(() => ({
  isBundledArchiveAvailable: vi.fn(async (_tool?: string): Promise<boolean> => false),
  resolveBundledTool: vi.fn(async (_tool: string): Promise<string | null> => null),
}))
vi.mock('@main/setup/runtimeTools.js', () => runtimeTools)
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
  resolver.resolveToolPath.mockReset().mockImplementation(async (tool: string) => (tool === 'codex' ? '/fresh/codex' : null))
  resolver.isExecutable.mockReset().mockImplementation(async (path: string) => path === '/fresh/codex')
  runtimeTools.isBundledArchiveAvailable.mockReset().mockResolvedValue(false)
  runtimeTools.resolveBundledTool.mockReset().mockResolvedValue(null)
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

// #1553: bundled opencode (bare binary) must only report `source: 'bundled'`
// when `resolveBundledTool` succeeds, not merely when an archive exists on
// disk. mitmdump (87 MB tarball) stays lazy on `isBundledArchiveAvailable` so
// startup does not block on extraction.
it('falls back to system for opencode when resolveBundledTool returns null, while keeping mitmdump lazy', async () => {
  runtimeTools.isBundledArchiveAvailable.mockResolvedValue(true)
  runtimeTools.resolveBundledTool.mockResolvedValue(null)
  resolver.resolveToolPath.mockImplementation(async (tool: string) =>
    tool === 'opencode' ? '/usr/local/bin/opencode' : null,
  )
  const { checkPrerequisites } = await import('./prerequisites.js')
  const check = await checkPrerequisites()
  expect(check.tools.opencode).toMatchObject({
    found: true,
    path: '/usr/local/bin/opencode',
    source: 'system',
  })
  expect(check.tools.mitmdump).toMatchObject({
    found: true,
    source: 'bundled',
  })
})

it('prefers a valid manual override over a bundled binary', async () => {
  runtimeTools.resolveBundledTool.mockImplementation(async (tool: string) =>
    tool === 'opencode' ? '/app.asar.unpacked/opencode' : null,
  )
  resolver.isExecutable.mockImplementation(async (path: string) => path === '/custom/opencode')
  await writeFile(
    join(dir, 'setup.json'),
    JSON.stringify({ version: 1, manualToolPaths: { opencode: '/custom/opencode' } }),
  )
  const { checkPrerequisites } = await import('./prerequisites.js')
  const check = await checkPrerequisites()
  expect(check.tools.opencode).toMatchObject({
    found: true,
    path: '/custom/opencode',
    source: 'system',
  })
})

it('deduplicates concurrent in-flight checkPrerequisites() calls', async () => {
  let releaseBrew!: () => void
  const brewGate = new Promise<void>(resolve => { releaseBrew = resolve })
  resolver.resolveToolPath.mockImplementation(async (tool: string) => {
    if (tool === 'brew') {
      await brewGate
      return '/opt/homebrew/bin/brew'
    }
    return null
  })
  const { checkPrerequisites } = await import('./prerequisites.js')
  const first = checkPrerequisites()
  const second = checkPrerequisites()
  expect(second).toBe(first)
  releaseBrew()
  const [a, b] = await Promise.all([first, second])
  expect(a).toBe(b)
  const brewCalls = resolver.resolveToolPath.mock.calls.filter(([tool]) => tool === 'brew')
  expect(brewCalls).toHaveLength(1)

  // After completion, a subsequent call runs a fresh check.
  await checkPrerequisites()
  const brewCallsAfter = resolver.resolveToolPath.mock.calls.filter(([tool]) => tool === 'brew')
  expect(brewCallsAfter).toHaveLength(2)
})

it('force: true bypasses in-flight deduplication and prevents the older check from clobbering newer state', async () => {
  let releaseFirstBrew!: () => void
  const firstBrewGate = new Promise<void>(resolve => { releaseFirstBrew = resolve })
  let brewInvocation = 0
  resolver.resolveToolPath.mockImplementation(async (tool: string) => {
    if (tool === 'brew') {
      brewInvocation += 1
      if (brewInvocation === 1) await firstBrewGate
      return '/opt/homebrew/bin/brew'
    }
    if (tool === 'codex') {
      return brewInvocation === 1 ? '/stale/codex' : '/newer/codex'
    }
    return null
  })
  resolver.isExecutable.mockImplementation(async (path: string) =>
    path === '/stale/codex' || path === '/newer/codex',
  )

  const { checkPrerequisites } = await import('./prerequisites.js')
  const { getToolPath } = await import('./toolchain.js')

  const staleCheck = checkPrerequisites()
  // A post-mutation check forces a fresh run while `staleCheck` is still parked.
  const freshCheck = checkPrerequisites({ force: true })
  expect(freshCheck).not.toBe(staleCheck)

  const fresh = await freshCheck
  expect(fresh.tools.codex).toMatchObject({ found: true, path: '/newer/codex' })
  expect(getToolPath('codex', '')).toBe('/newer/codex')

  // Now let the older check finish; it must NOT overwrite disk or toolchain.
  releaseFirstBrew()
  await staleCheck
  expect(JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')).toolPaths.codex).toBe('/newer/codex')
  expect(getToolPath('codex', '')).toBe('/newer/codex')
})
