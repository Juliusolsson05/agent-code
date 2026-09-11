import { describe, expect, it } from 'vitest'

import { mapOpencodeMessageToFeedEntries } from './mapper'

// The OpenCode mapper's filtering contract. Every OpenCode feed row comes
// through it (live committed records, database history, remote backfill), so
// what it drops is invisible everywhere, and what it keeps reads as something
// the user or the model wrote. Records below are shaped as OpenCode's
// database holds them (`{ info, parts }`); expected entries are written out
// by hand.

const user = (parts: Array<Record<string, unknown>>) => ({
  info: { id: 'msg_user', sessionID: 'ses_1', role: 'user', time: { created: 1_000 } },
  parts,
})

describe('mapOpencodeMessageToFeedEntries', () => {
  it('drops text OpenCode marked ignored and keeps the rest of the message', () => {
    // `ignored` is what an ACP client's audience=user part becomes: OpenCode's
    // TUI does not show it as conversation, so neither may the feed.
    const mapped = mapOpencodeMessageToFeedEntries(user([
      { id: 'prt_1', type: 'text', text: 'Explain the failing test' },
      { id: 'prt_2', type: 'text', text: 'resource notice for the client', ignored: true },
    ]))
    expect(mapped).toEqual({
      historyMarker: 'msg_user',
      entries: [{
        type: 'user',
        uuid: 'msg_user',
        parentUuid: null,
        timestamp: '1970-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Explain the failing test' }] },
      }],
    })
  })

  it('maps an all-synthetic user message to no row, but keeps its id as the paging marker', () => {
    // OpenCode's own "Summarize the task tool output above and continue" is
    // an entirely synthetic user message. It must not show as a prompt, and a
    // history page that starts with it must still hand older paging a cursor,
    // or paging would stall on it.
    const mapped = mapOpencodeMessageToFeedEntries(user([
      { id: 'prt_1', type: 'text', text: 'Summarize the task tool output above and continue with your task.', synthetic: true },
    ]))
    expect(mapped).toEqual({ entries: [], historyMarker: 'msg_user' })
  })

  it('leaves a non-text part alone even when it carries a synthetic flag', () => {
    // OpenCode writes `synthetic` only on user text parts. The filter is for
    // text; a tool call or reasoning block keeps its row whatever it carries.
    const mapped = mapOpencodeMessageToFeedEntries({
      info: { id: 'msg_assistant', sessionID: 'ses_1', role: 'assistant', time: { created: 2_000, completed: 3_000 }, finish: 'tool-calls' },
      parts: [
        { id: 'prt_r', type: 'reasoning', text: 'Run the suite first.', synthetic: true },
        { id: 'prt_t', type: 'tool', tool: 'bash', callID: 'call_1', synthetic: true, state: { status: 'completed', input: { command: 'npm test' }, output: '1 failing' } },
      ],
    })
    expect(mapped.historyMarker).toBe('msg_assistant')
    expect(mapped.entries).toEqual([
      {
        type: 'assistant',
        uuid: 'msg_assistant',
        parentUuid: null,
        timestamp: '1970-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Run the suite first.' },
            { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'msg_assistant:result:call_1',
        parentUuid: null,
        timestamp: '1970-01-01T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1 failing', is_error: false }] },
      },
    ])
  })

  it('holds back an assistant that has not completed, but still pages past it', () => {
    const mapped = mapOpencodeMessageToFeedEntries({
      info: { id: 'msg_streaming', sessionID: 'ses_1', role: 'assistant', time: { created: 4_000 } },
      parts: [{ id: 'prt_1', type: 'text', text: 'partial' }],
    })
    expect(mapped).toEqual({ entries: [], historyMarker: 'msg_streaming' })
  })
})
