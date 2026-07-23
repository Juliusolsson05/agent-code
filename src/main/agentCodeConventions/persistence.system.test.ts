import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyAgentCodeConventionsDocument } from '@shared/types/agentCodeConventions.js'
import {
  readAgentCodeConventionsState,
  writeAgentCodeConventionsState,
} from './persistence.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-conventions-persistence-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Agent Code conventions persistence', () => {
  it('round-trips app-owned state atomically', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'state', 'conventions.json')
    const document = createEmptyAgentCodeConventionsDocument()
    document.revision = 3
    document.markdown = '# Rules'
    await writeAgentCodeConventionsState(statePath, document)

    expect(await readAgentCodeConventionsState(statePath)).toEqual({ kind: 'ok', document })
    expect((await readFile(statePath, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('preserves malformed and unsupported state as recovery-required', async () => {
    const root = await temporaryDirectory()
    const malformed = join(root, 'malformed.json')
    await writeFile(malformed, '{not json')
    expect(await readAgentCodeConventionsState(malformed)).toMatchObject({
      kind: 'recovery-required',
      stateFilePath: malformed,
    })

    const newer = join(root, 'newer.json')
    await writeFile(newer, JSON.stringify({
      schemaVersion: 999,
      revision: 7,
      enabled: true,
      markdown: '# Preserve me',
      updatedAt: null,
      materializations: {},
      pendingOperations: {},
    }))
    expect(await readAgentCodeConventionsState(newer)).toMatchObject({
      kind: 'recovery-required',
      document: { revision: 7, enabled: true, markdown: '# Preserve me' },
    })
  })

  it.runIf(process.platform !== 'win32')('rejects a symlink state file without following it', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'source.json')
    const statePath = join(root, 'conventions.json')
    await writeFile(source, JSON.stringify(createEmptyAgentCodeConventionsDocument()))
    await symlink(source, statePath)
    expect(await readAgentCodeConventionsState(statePath)).toMatchObject({
      kind: 'recovery-required',
      stateFilePath: statePath,
    })
  })
})
