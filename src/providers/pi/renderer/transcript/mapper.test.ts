import { describe, expect, it } from 'vitest'
import { listLiveFixtures, loadLiveFixture, loadDurableFixtureText } from 'pi-terminal-headless/testing/index'
import { parseSessionText } from 'pi-terminal-headless'

import { extractPiProviderSessionId, mapPiRowToFeedEntries, PI_IDENTITY_ENVELOPE_TYPE } from './mapper'

// The Pi row mapper over every recorded row. Expectations are stated from the
// rows themselves (their role, blocks, ids), not from the mapper.

const allRows = () => listLiveFixtures().flatMap(name => Object.values(loadLiveFixture(name).files).flatMap(rows => parseSessionText(rows.map(r => JSON.stringify(r)).join('\n') + '\n').rows))

describe('mapPiRowToFeedEntries', () => {
  it('every row keeps its entry id as the history marker; only user/assistant/toolResult messages become entries', () => {
    const rows = allRows()
    expect(rows.length).toBeGreaterThan(100)
    for (const row of rows) {
      const mapped = mapPiRowToFeedEntries(row)
      expect(mapped.historyMarker).toBe(row.id)
      const role = row.type === 'message' ? (row.message as { role: string }).role : null
      if (!role || !['user', 'assistant', 'toolResult'].includes(role)) expect(mapped.entries).toEqual([])
      for (const entry of mapped.entries) expect(entry.uuid).toBe(`pi:${row.id}`)
    }
  })

  it('assistant blocks keep Pi’s order: thinking, text, then tool_use carrying the call id and arguments', () => {
    const toolRow = allRows().find(row => row.type === 'message' && (row.message as { stopReason?: string }).stopReason === 'toolUse')!
    // Entry is a union over every provider's row types; these are messages.
    const entry = mapPiRowToFeedEntries(toolRow).entries[0] as unknown as { message: { content: unknown } }
    expect((entry.message.content as Array<{ type: string }>).map(block => block.type)).toEqual(['thinking', 'text', 'tool_use'])
    const call = (toolRow.message as { content: Array<{ type: string; id: string; arguments: unknown }> }).content.find(block => block.type === 'toolCall')!
    expect((entry.message.content as Array<Record<string, unknown>>)[2]).toMatchObject({ type: 'tool_use', id: call.id, name: 'bash', input: call.arguments })
  })

  it('a tool result is a separate user entry threaded to its call by toolCallId', () => {
    const resultRow = allRows().find(row => row.type === 'message' && (row.message as { role: string }).role === 'toolResult')!
    const [entry] = mapPiRowToFeedEntries(resultRow).entries
    expect(entry).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: (resultRow.message as { toolCallId: string }).toolCallId, is_error: false }] } })
  })

  it('an errored reply saved with empty content produces no bubble (the failure travels as api_error)', () => {
    const errored = allRows().find(row => row.type === 'message' && (row.message as { stopReason?: string }).stopReason === 'error')!
    expect(mapPiRowToFeedEntries(errored).entries).toEqual([])
  })

  it('the user’s own !bash row is not a prompt (it would pollute View Prompts)', () => {
    const bash = allRows().find(row => row.type === 'message' && (row.message as { role: string }).role === 'bashExecution')!
    expect(mapPiRowToFeedEntries(bash).entries).toEqual([])
  })

  it('maps the pre-migration v1 shape the same way (rows get line-based ids)', () => {
    const { rows } = parseSessionText(loadDurableFixtureText('v1-linear.jsonl'))
    const entries = rows.flatMap(row => mapPiRowToFeedEntries(row).entries)
    expect(entries.map(entry => entry.type)).toEqual(['user', 'user', 'assistant', 'user', 'assistant'])
  })
})

describe('provider session identity', () => {
  it('only the runtime identity envelope names a session — Pi rows carry no session id', () => {
    expect(extractPiProviderSessionId({ type: PI_IDENTITY_ENVELOPE_TYPE, sessionId: 'abc' })).toBe('abc')
    for (const row of allRows()) expect(extractPiProviderSessionId(row)).toBeNull()
    expect(mapPiRowToFeedEntries({ type: PI_IDENTITY_ENVELOPE_TYPE, sessionId: 'abc' })).toEqual({ entries: [], historyMarker: null })
  })
})
