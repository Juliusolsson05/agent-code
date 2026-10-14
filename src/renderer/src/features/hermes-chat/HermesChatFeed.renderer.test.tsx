import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'

import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { createHermesTranscriptEntryMapper } from '@providers/hermes/renderer/transcript/mapper'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useAgentFeedModel } from '@renderer/features/feed/agent/useAgentFeedModel'
import { extractLatestUserPrompts } from '@renderer/features/workspace/lib/latestUserPrompts'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'

import { HermesChatFeed, type HermesChatControls } from './HermesChatFeed'

// The chat surface honours the pane controls every agent surface gets
// (round-1 reviews x1 #2, x2 #1-#3, #1482). Rows are the recorded S12 resume
// (120 rows / 60 turns, hermes-headless research/corpus), mapped by the real
// Hermes mapper and owned by the real ledger (useAgentFeedModel).

function recordedRows(scenario: string): Record<string, unknown>[] {
  return inboundFrames(latestRecording(scenario))
    .map((frame) => (frame.result as { messages?: Record<string, unknown>[] } | undefined)?.messages)
    .filter((rows): rows is Record<string, unknown>[] => Array.isArray(rows))
    .sort((a, b) => b.length - a.length)[0]!
}

function entries(scenario: string) {
  const mapper = createHermesTranscriptEntryMapper()
  return recordedRows(scenario).flatMap((row, index) =>
    mapper.map({ hermes: 1, key: typeof row.row_id === 'number' ? `row:${row.row_id}` : `idx:${index}`, storedSessionId: 's', row }).entries)
}

function Mounted({ runtime, controls }: { runtime: SessionRuntime; controls: HermesChatControls }) {
  const model = useAgentFeedModel(runtime, 'hermes', 'chat-pane')
  return <HermesChatFeed sessionId="chat-pane" items={model.ledgerFeedPlan.items} connectionName="VPS" {...controls} />
}

function scroller(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[data-hermes-chat]')!
  Object.defineProperties(node, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 100 } })
  return node
}

describe('HermesChatFeed pane controls', () => {
  it('asks for older messages when the reader scrolls to the top of a partial history', async () => {
    const runtime = { ...emptyRuntime(), entries: entries('S12'), hasOlderHistory: true }
    const load = vi.fn(async () => undefined)
    const view = render(<Mounted runtime={runtime} controls={{ hasOlderHistory: true, onLoadOlderHistory: load }} />)
    const node = scroller(view.container)
    node.scrollTop = 0
    await act(async () => { fireEvent.scroll(node) })
    expect(load).toHaveBeenCalledTimes(1)
    expect(view.getByText('Scroll up for earlier messages')).toBeTruthy()
  })

  it('does not page while the whole conversation is loaded', async () => {
    const load = vi.fn(async () => undefined)
    const view = render(<Mounted runtime={{ ...emptyRuntime(), entries: entries('S12') }} controls={{ onLoadOlderHistory: load }} />)
    const node = scroller(view.container)
    node.scrollTop = 0
    await act(async () => { fireEvent.scroll(node) })
    expect(load).not.toHaveBeenCalled()
  })

  it('jumps to the latest message on request even after the reader scrolled up', () => {
    const runtime = { ...emptyRuntime(), entries: entries('S12') }
    const view = render(<Mounted runtime={runtime} controls={{}} />)
    const node = scroller(view.container)
    node.scrollTop = 20
    fireEvent.scroll(node)
    view.rerender(<Mounted runtime={runtime} controls={{ scrollToLatestRequest: 1 }} />)
    expect(node.scrollTop).toBe(2000)
  })

  it('marks the assistant message the Copy Assistant Message picker selected', () => {
    const rows = entries('S12')
    const assistant = rows.find((entry) => entry.type === 'assistant')!
    const view = render(<Mounted runtime={{ ...emptyRuntime(), entries: rows }} controls={{ pickerSelectedUuid: assistant.uuid }} />)
    const selected = view.container.querySelectorAll('[aria-current="true"]')
    expect(selected).toHaveLength(1)
    expect(selected[0]!.closest(`[data-entry-uuid="${assistant.uuid}"]`)).not.toBeNull()
  })

  it('offers View Prompts, and it lists the recorded prompt (S4)', () => {
    expect(extractLatestUserPrompts(entries('S4'), 'hermes').map((prompt) => prompt.text)).toEqual(['[[hh:tools]] Run the tools.'])
    const command = sessionCommands.find((entry) => entry.id === 'view-prompts')!
    expect(command.when!({ target: 'p', workspace: { state: { sessions: { p: { kind: 'hermes', cwd: '/' } } } } } as never)).toBe(true)
  })
})

