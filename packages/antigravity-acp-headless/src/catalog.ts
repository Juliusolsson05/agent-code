// Short-lived ACP queries for the conversation catalog: list every
// conversation agy knows, or replay one to read its prompts.
//
// WHY over ACP and a process of its own: agy's conversation index is a
// private SQLite store (see paths.ts), and session/list + session/load are
// the supported way to read it. The caller (the app) spawns `agy acp`, hands
// its stdio here, and kills it after — this module never spawns (owner rule).

import type { Readable, Writable } from 'node:stream'

import { AcpConnection } from './acp/AcpConnection.js'
import { normalizeAntigravityCwd } from './paths.js'
import { TurnAssembler, type AntigravityRow } from './transcript/assembler.js'

export type AntigravityConversationListing = {
  sessionId: string
  cwd: string | null
  title: string | null
  updatedAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function withConnection<T>(input: Readable, output: Writable, run: (connection: AcpConnection, updates: (handler: ((update: Record<string, unknown>) => void) | null) => void) => Promise<T>, sessionId?: string): Promise<T> {
  let onUpdate: ((update: Record<string, unknown>) => void) | null = null
  const connection = new AcpConnection(input, output, {
    onNotification: (method, params) => {
      if (method === 'session/update' && isRecord(params) && params.sessionId === sessionId && isRecord(params.update)) onUpdate?.(params.update)
    },
    // A read-only query never grants anything: refuse every agent request.
    onRequest: request => connection.respondError(request.id, -32601, 'read-only catalog client'),
    onClose: () => {},
  })
  try {
    await connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-code-catalog', version: '0' },
    }, 60_000)
    return await run(connection, handler => {
      onUpdate = handler
    })
  } finally {
    connection.close('query done')
  }
}

/** Every conversation agy lists (session/list follows cursors, bounded). */
export async function listAntigravityConversations(input: Readable, output: Writable): Promise<AntigravityConversationListing[]> {
  return withConnection(input, output, async connection => {
    const listings: AntigravityConversationListing[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const result = await connection.request('session/list', cursor ? { cursor } : {}, 60_000)
      const sessions = isRecord(result) && Array.isArray(result.sessions) ? result.sessions : []
      for (const session of sessions) {
        if (!isRecord(session) || typeof session.sessionId !== 'string') continue
        const updatedAt = typeof session.updatedAt === 'string' ? Date.parse(session.updatedAt) : NaN
        listings.push({
          sessionId: session.sessionId,
          cwd: typeof session.cwd === 'string' ? normalizeAntigravityCwd(session.cwd) : null,
          title: typeof session.title === 'string' && session.title.trim() ? session.title.trim() : null,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
        })
      }
      cursor = isRecord(result) && typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return listings
  })
}

/** Replay one conversation (session/load) into committed rows, without running anything. */
export async function readAntigravityConversation(input: Readable, output: Writable, options: { sessionId: string; cwd: string }): Promise<AntigravityRow[]> {
  return withConnection(input, output, async (connection, updates) => {
    const rows: AntigravityRow[] = []
    const assembler = new TurnAssembler(options.sessionId, { row: row => rows.push(row), semantic: () => {} })
    updates(update => assembler.apply(update))
    await connection.request('session/load', { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] }, 120_000)
    assembler.flush()
    return rows.sort((a, b) => a.ordinal - b.ordinal)
  }, options.sessionId)
}
