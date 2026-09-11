import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectionDatabase,
  listDurableFixtures,
  loadDurableFixture,
} from 'opencode-terminal-headless/testing/index'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { opencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'

// What a parent agent actually does with an OpenCode child: take the
// `opencode://session/<id>` path Agent Management listed and hand it to the
// transcript tools, over MCP. The tools read a real database built from a
// recorded session (never the user's own).

const fixture = vi.hoisted(() => ({ file: '' }))
vi.mock('@providers/opencode/runtime/opencodeDatabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/opencode/runtime/opencodeDatabase.js')>()
  return {
    ...actual,
    opencodeDatabase: actual.createOpencodeDatabase({ resolveDbPath: async () => fixture.file }),
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-opencode-transcript-'))
})
afterEach(() => {
  opencodeDatabase.release()
  rmSync(dir, { recursive: true, force: true })
})

async function callTranscriptTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createBuiltInMcpServer({ sessionId: 'parent', cwd: '/tmp/project', domains: ['agent_transcripts'] })
  const client = new Client({ name: 'opencode-transcript-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({ name, arguments: args })
    const [content] = result.content as Array<{ type: string; text: string }>
    return JSON.parse(content!.text) as Record<string, unknown>
  } finally {
    await client.close()
    await server.close()
  }
}

describe('agent transcript MCP tools with an OpenCode locator', () => {
  it('reads and inspects an OpenCode session by opencode://session/<id>, with provider auto-detected', async () => {
    const recorded = loadDurableFixture(listDurableFixtures().find(name => name.includes('ses_47fca639'))!)
    fixture.file = join(dir, 'opencode.db')
    createProjectionDatabase(recorded, fixture.file)
    const path = `opencode://session/${recorded.meta.sessionID}`

    const read = await callTranscriptTool('agent_transcript_read_file', { path, projection: 'conversation' })
    expect(read).toMatchObject({ ok: true, provider: 'opencode', path })
    const kinds = (read.items as Array<{ kind: string }>).map(item => item.kind)
    expect(kinds[0]).toBe('user_message')
    expect(kinds).toContain('assistant_message')

    const inspect = await callTranscriptTool('agent_transcript_inspect_file', { path })
    expect(inspect).toMatchObject({ ok: true, provider: 'opencode', stats: { totalEvents: recorded.messages.length } })
  })
})
