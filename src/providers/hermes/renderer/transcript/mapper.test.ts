import { describe, expect, it } from 'vitest'

import { mapHermesRow } from '@providers/hermes/renderer/transcript/mapper'

// Review b (#1482): the recorded corpus has no row with `display_kind`, no
// assistant `reasoning` and no tool `content`, so those mapper branches were
// unpinned. They are Hermes' DOCUMENTED row contract and fire on real servers:
// the fixtures below are schema-derived from TranscriptMessage
// (vendor/hermes-agent-src/tui_gateway/contracts/common.py), with
// `display_kind: "hidden"` taken from Hermes' own writers (hermes_state_*.py).
// Everything else about each row copies the recorded S4 shapes.

const payload = (key: string, row: Record<string, unknown>) => ({ hermes: 1, key, storedSessionId: 'stored', row })

describe('mapHermesRow, schema-derived rows the corpus never recorded', () => {
  it('drops a hidden row (Hermes-internal turns, e.g. auto-continue) but keeps its history marker', () => {
    const mapped = mapHermesRow(payload('row:9', { role: 'user', text: 'continue', timestamp: 1, row_id: 9, display_kind: 'hidden' }))
    expect(mapped).toEqual({ entries: [], historyMarker: 'row:9' })
  })

  it('shows assistant reasoning as a thinking block before the answer', () => {
    const mapped = mapHermesRow(payload('row:7', { role: 'assistant', text: 'All three tools ran.', reasoning: 'Run them in order.', timestamp: 1, row_id: 7 }))
    expect(mapped.entries[0]).toMatchObject({ message: { content: [
      { type: 'thinking', thinking: 'Run them in order.' },
      { type: 'text', text: 'All three tools ran.' },
    ] } })
  })

  it('pairs a tool row with a finished result carrying the content Hermes kept', () => {
    const mapped = mapHermesRow(payload('tool:call_tools_0_0', {
      role: 'tool', name: 'terminal', context: 'ls', tool_call_id: 'call_tools_0_0', timestamp: 1, args: { command: 'ls' }, content: 'a.txt',
    }))
    expect(mapped.entries).toHaveLength(2)
    expect(mapped.entries[0]).toMatchObject({ message: { content: [{ type: 'tool_use', id: 'call_tools_0_0', name: 'terminal', input: { command: 'ls' } }] } })
    expect(mapped.entries[1]).toMatchObject({ message: { content: [{ type: 'tool_result', tool_use_id: 'call_tools_0_0', content: 'a.txt' }] } })
  })
})
