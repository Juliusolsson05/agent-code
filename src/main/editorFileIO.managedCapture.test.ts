import { lstat, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({
  enabled: false,
  destination: '',
  captureFile: '',
  externalCandidate: '',
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (race.enabled && from === race.destination && to === race.captureFile) {
        race.enabled = false
        await actual.rename(race.externalCandidate, race.destination)
      }
      return actual.rename(from, to)
    },
  }
})

import { atomicWriteTextFile, editorFileVersion } from './editorFileIO.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  race.enabled = false
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('managed-file capture publication', () => {
  it('preserves an external replacement that lands after the final version check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-managed-capture-'))
    temporaryDirectories.push(root)
    const destination = join(root, 'SKILL.md')
    const externalCandidate = join(root, 'external.md')
    const temporaryPath = join(root, '.managed-write.tmp')
    const captureDirectory = join(root, '.managed-write.capture')
    await writeFile(destination, 'owned version')
    await writeFile(externalCandidate, 'external replacement')
    const expectedVersion = editorFileVersion(await lstat(destination))
    race.destination = destination
    race.captureFile = join(captureDirectory, basename(destination))
    race.externalCandidate = externalCandidate
    race.enabled = true

    const result = await atomicWriteTextFile({
      absolutePath: destination,
      text: 'new managed version',
      expectedVersion,
      maxBytes: 1_024,
      temporaryPath,
      captureDirectory,
    })

    expect(result).toEqual({ ok: false, conflictKind: 'changed' })
    expect(await readFile(destination, 'utf8')).toBe('external replacement')
  })
})
