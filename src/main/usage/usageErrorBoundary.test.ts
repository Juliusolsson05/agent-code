import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

// #1451 steering q132 (SECURITY): the usage error boundary allowed messages by
// PREFIX — `/^(Codex|Grok|OpenCode|opencode) auth\.json /`, any message
// containing "Keychain", any starting "Grok login expired". A prefix proves
// nothing about the rest of the sentence: "Codex auth.json /Users/alice/...
// token=abc" passed whole, and the usage MCP domain hands that row to agents.
// Only EXACT first-party sentences may pass now; everything else is fixed text.
// Pinned at the sanitizer, then end to end through the real Usage reader
// (getUsageSnapshot's per-provider catch) and the real usage_read tool.

const PREFIX_SHAPED = [
  "Codex auth.json /Users/alice/.codex/auth.json token=abc",
  'Grok auth.json is unexpectedly large; refusing to read it. token=abc /Users/alice/.grok/auth.json',
  'Claude Keychain credentials were empty. /Users/alice/Library token=abc',
  'security: SecKeychainSearchCopyNext: The specified item could not be found in the Keychain. /Users/alice',
  'Grok login expired — token=abc https://example.test/Users/alice',
]
const LEAKS = [/\/Users\//, /token=/, /https?:\/\//]

const failing = vi.hoisted(() => ({ message: '' }))
vi.mock('@main/setup/providerEnablement.js', () => ({
  getProviderEnablementSnapshot: async () => ({ entries: [], opencodeUsageSource: null }),
}))
vi.mock('@main/usage/sources.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@main/usage/sources.js')>()
  return {
    ...actual,
    listActiveUsageSourceIds: () => ['codex'],
    USAGE_SOURCES: {
      ...actual.USAGE_SOURCES,
      codex: { ...actual.USAGE_SOURCES.codex!, read: async () => { throw new Error(failing.message) } },
    },
  }
})

import { sanitizeUsageError } from './normalize.js'
import { readUsageSnapshotForTools } from './usageService.js'
import { GROK_LOGIN_EXPIRED_COPY } from './grokUsage.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'

describe('usage error boundary (#1451 q132)', () => {
  it.each(PREFIX_SHAPED)('never passes a prefix-shaped message whole: %s', message => {
    const out = sanitizeUsageError(new Error(message), 'Could not load Codex usage.')
    for (const leak of LEAKS) expect(out).not.toMatch(leak)
    expect(out).not.toBe(message)
  })

  it('keeps each exact first-party sentence, and only those', () => {
    for (const own of [
      'Claude usage currently requires macOS Keychain credentials.',
      'Claude Keychain credentials were empty.',
      'Claude Keychain credentials do not include an OAuth access token.',
      'Codex auth.json does not include an access token.',
      'Grok auth.json is unexpectedly large; refusing to read it.',
      'Grok auth.json does not include a login key.',
      'OpenCode auth.json is unexpectedly large; refusing to read it.',
      'opencode auth.json has no zai-coding-plan key.',
      GROK_LOGIN_EXPIRED_COPY,
    ]) expect(sanitizeUsageError(new Error(own), 'fallback')).toBe(own)
  })

  it.each(PREFIX_SHAPED)('a provider failing with it reaches an agent only as fixed text: %s', async message => {
    failing.message = message
    const snapshot = await readUsageSnapshotForTools({ force: true }) as { providers: Array<{ provider: string; status: string; message?: string }> }
    const row = snapshot.providers.find(p => p.provider === 'codex')!
    expect(row.status).toBe('error')
    for (const leak of LEAKS) expect(row.message).not.toMatch(leak)

    const server = createBuiltInMcpServer({ sessionId: 'agent-1', cwd: '/tmp/project', domains: ['usage'] }, { readUsageSnapshot: () => readUsageSnapshotForTools({ force: true }) })
    const client = new Client({ name: 'usage-boundary', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'usage_read', arguments: {} })
      const text = (result.content as Array<{ text: string }>)[0]!.text
      for (const leak of LEAKS) expect(text).not.toMatch(leak)
    } finally {
      await client.close()
    }
  })
})
