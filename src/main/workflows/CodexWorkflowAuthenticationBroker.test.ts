import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CodexWorkflowAuthenticationBroker,
  type CodexCredentialSource,
} from './CodexWorkflowAuthenticationBroker.js'

function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
}

class MemoryCredentialSource implements CodexCredentialSource {
  serialized: string | null
  generation = 1
  saves = 0

  constructor(value: unknown) {
    this.serialized = JSON.stringify(value)
  }

  async load() {
    return this.serialized === null
      ? null
      : { serialized: this.serialized, generation: String(this.generation) }
  }

  async save(serialized: string, expectedGeneration: string) {
    if (expectedGeneration !== String(this.generation)) return false
    this.serialized = serialized
    this.generation += 1
    this.saves += 1
    return true
  }
}

describe('CodexWorkflowAuthenticationBroker', () => {
  it('coalesces parallel preparation and gives children an access-only snapshot', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z')
    const source = new MemoryCredentialSource({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt(Math.floor(now / 1_000) + 3_600),
        access_token: jwt(Math.floor(now / 1_000) + 3_600),
        refresh_token: 'one-time-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2026-07-01T00:00:00.000Z',
    })
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
      now: () => now,
    })

    await Promise.all(Array.from({ length: 9 }, () => broker.prepare()))

    expect(source.saves).toBe(0)
    expect(source.serialized).toContain('one-time-refresh')
    const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as {
      auth_mode: string
      tokens: { refresh_token: string; account_id: string }
    }
    expect(snapshot.auth_mode).toBe('chatgptAuthTokens')
    expect(snapshot.tokens.refresh_token).toBe('')
    expect(snapshot.tokens.account_id).toBe('account-1')
    expect((await stat(snapshotFile)).mode & 0o777).toBe(0o600)
  })

  it('supports API-key auth without calling the OAuth authority', async () => {
    const source = new MemoryCredentialSource({ OPENAI_API_KEY: 'sk-fixture', tokens: null })
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
    })

    await broker.prepare()

    await expect(readFile(snapshotFile, 'utf8')).resolves.toContain('sk-fixture')
  })

  it('never consumes the interactive refresh-token lineage when access is near expiry', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z')
    const source = new MemoryCredentialSource({
      tokens: {
        access_token: jwt(Math.floor(now / 1_000) - 60),
        refresh_token: 'old-refresh',
        account_id: 'account-1',
      },
    })
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    await writeFile(snapshotFile, 'stale snapshot')
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
      now: () => now,
    })

    await expect(broker.prepare()).rejects.toThrow(/interactive Codex/i)

    expect(source.serialized).toContain('old-refresh')
    expect(source.saves).toBe(0)
    await expect(readFile(snapshotFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
