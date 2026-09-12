import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LiveFixtureWriter, sessionRowFor } from 'opencode-terminal-headless/testing/index'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { opencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'

const fixture = vi.hoisted(() => ({ file: '' }))
vi.mock('@providers/opencode/runtime/opencodeDatabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/opencode/runtime/opencodeDatabase.js')>()
  return { ...actual, opencodeDatabase: actual.createOpencodeDatabase({ resolveDbPath: async () => fixture.file }) }
})
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-transcript-search-'))
  fixture.file = join(dir, 'opencode.db')
})
afterEach(() => {
  opencodeDatabase.release()
  rmSync(dir, { recursive: true, force: true })
})

it('searches an OpenCode locator through MCP with kind filters, caps, and context', async () => {
  // WHY a real MCP round trip: direct reader tests cannot detect registration
  // mistakes (lost locator, provider, filter, context, or cap arguments). The
  // database facade is the sole injected boundary; everything from the MCP
  // schema to SQLite traversal runs as it does for a parent reading a child.
  const sessionID = 'ses_mcp_search'
  const writer = new LiveFixtureWriter(fixture.file, sessionID, sessionRowFor(sessionID))
  try {
    const rows = [
      { role: 'user', part: { type: 'text', text: 'needle prompt' } },
      { role: 'assistant', part: { type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed', input: { filePath: '/repo/needle.ts' } } } },
      { role: 'assistant', part: { type: 'text', text: 'needle answer' } },
      { role: 'user', part: { type: 'text', text: 'next question' } },
      { role: 'assistant', part: { type: 'text', text: 'needle second answer' } },
    ]
    rows.forEach(({ role, part }, i) => {
      const id = `msg_${i}`
      writer.apply('message.updated.1', { sessionID, info: { id, sessionID, role, time: { created: 100 + i, completed: 200 + i }, finish: 'stop' } })
      writer.apply('message.part.updated.1', { sessionID, part: { id: `prt_${i}`, sessionID, messageID: id, ...part } })
    })
  } finally {
    writer.close()
  }
  const server = createBuiltInMcpServer({ sessionId: 'parent', cwd: '/tmp/project', domains: ['agent_transcripts'] })
  const client = new Client({ name: 'transcript-search-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const path = `opencode://session/${sessionID}`
    const result = await client.callTool({ name: 'agent_transcript_search_file', arguments: {
      path, query: 'NEEDLE', kinds: ['assistant_message'], maxMatches: 1, contextItems: 1, maxCharsPerMatch: 50,
    } })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]?.type).toBe('text')
    expect(JSON.parse(content[0]!.text)).toEqual({
      ok: true, path, provider: 'opencode', query: 'NEEDLE', truncated: true,
      matches: [{
        item: { kind: 'assistant_message', timestamp: 102, text: 'needle answer', final: true },
        before: [{ kind: 'tool_read', timestamp: 101, tool: 'read', target: '/repo/needle.ts', excerpt: 'read: /repo/needle.ts' }],
        after: [{ kind: 'user_message', timestamp: 103, text: 'next question' }],
      }],
      stats: { totalEvents: 5, returnedItems: 1, userMessages: 2, assistantMessages: 2, toolReads: 1, toolWrites: 0, shellCommands: 0, patches: 0, testRuns: 0, parseErrors: 0 },
    })
  } finally {
    await client.close()
    await server.close()
  }
})
