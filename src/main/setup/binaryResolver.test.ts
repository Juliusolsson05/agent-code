import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shellMock = vi.hoisted(() => ({ runLoginShell: vi.fn() }))
vi.mock('@main/setup/shell.js', () => shellMock)

const homeMock = vi.hoisted(() => ({ dir: '' }))
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => homeMock.dir || actual.homedir(),
  }
})

import { resolveToolPath } from './binaryResolver.js'

let dir: string
const originalPath = process.env.PATH

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'binary-resolver-'))
  homeMock.dir = dir
  shellMock.runLoginShell.mockReset()
  process.env.PATH = ''
})

afterEach(async () => {
  process.env.PATH = originalPath
  homeMock.dir = ''
  await rm(dir, { recursive: true, force: true })
})

async function makeExecutable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

describe('resolveToolPath (#1553)', () => {
  it('reads the last non-empty line of login-shell stdout so noisy .zprofile banners do not break detection', async () => {
    const bin = join(dir, 'custom', 'claude')
    await makeExecutable(bin)
    shellMock.runLoginShell.mockResolvedValue({
      stdout: `Welcome to zsh!\nLoaded nvm v20\n\n${bin}\n\n`,
      stderr: '',
    })

    expect(await resolveToolPath('claude')).toBe(bin)
  })

  it.each([
    ['mise shims', ['.local', 'share', 'mise', 'shims']],
    ['pnpm home', ['Library', 'pnpm']],
    ['npm-global', ['.npm-global', 'bin']],
    ['claude local', ['.claude', 'local']],
  ])('falls back to well-known macOS bin dir: %s', async (_label, segments) => {
    shellMock.runLoginShell.mockRejectedValue(new Error('shell probe failed'))
    const bin = join(dir, ...segments, 'claude')
    await makeExecutable(bin)

    expect(await resolveToolPath('claude')).toBe(bin)
  })
})
