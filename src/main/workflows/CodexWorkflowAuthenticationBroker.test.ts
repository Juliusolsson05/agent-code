import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

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
  it('coalesces parallel refresh and gives children an access-only snapshot', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z')
    const source = new MemoryCredentialSource({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt(Math.floor(now / 1_000) - 60),
        access_token: jwt(Math.floor(now / 1_000) - 60),
        refresh_token: 'one-time-refresh',
        account_id: 'account-1',
      },
      last_refresh: '2026-07-01T00:00:00.000Z',
    })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: jwt(Math.floor(now / 1_000) + 3_600),
      refresh_token: 'rotated-refresh',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    })

    await Promise.all(Array.from({ length: 9 }, () => broker.prepare()))

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(source.saves).toBe(1)
    expect(source.serialized).toContain('rotated-refresh')
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
    const fetchImpl = vi.fn()
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
      fetchImpl: fetchImpl as typeof fetch,
    })

    await broker.prepare()

    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(readFile(snapshotFile, 'utf8')).resolves.toContain('sk-fixture')
  })

  it('does not overwrite an account generation changed during refresh', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z')
    const source = new MemoryCredentialSource({
      tokens: {
        access_token: jwt(Math.floor(now / 1_000) - 60),
        refresh_token: 'old-refresh',
        account_id: 'account-1',
      },
    })
    const fetchImpl = vi.fn(async () => {
      // Another Codex instance completed login/refresh while this request was in flight. The
      // broker must discard its now-stale response and rebuild from the winning account bytes.
      source.serialized = JSON.stringify({
        tokens: {
          access_token: jwt(Math.floor(now / 1_000) + 3_600),
          refresh_token: 'winning-refresh',
          account_id: 'account-2',
        },
      })
      source.generation += 1
      return new Response(JSON.stringify({
        access_token: jwt(Math.floor(now / 1_000) + 3_600),
        refresh_token: 'stale-response-refresh',
      }), { status: 200 })
    })
    const snapshotFile = join(tmpdir(), `workflow-auth-${randomUUID()}.json`)
    const broker = new CodexWorkflowAuthenticationBroker({
      interactiveCodexHome: '/unused',
      snapshotFile,
      source,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    })

    await broker.prepare()

    expect(source.serialized).toContain('winning-refresh')
    expect(source.serialized).not.toContain('stale-response-refresh')
    await expect(readFile(snapshotFile, 'utf8')).resolves.toContain('account-2')
  })
})
