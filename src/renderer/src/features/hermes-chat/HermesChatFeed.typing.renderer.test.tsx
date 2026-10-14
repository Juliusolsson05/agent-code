import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { createHermesTranscriptEntryMapper } from '@providers/hermes/renderer/transcript/mapper'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useAgentFeedModel } from '@renderer/features/feed/agent/useAgentFeedModel'

import { HermesChatFeed } from './HermesChatFeed'

// The owner, 2026-10-14: "the Hermes composer is painstakingly slow".
//
// Root cause: every composer keystroke re-renders TileLeaf (the draft lives in
// the runtime, workspace/hook/actions/draft.ts), and the chat re-rendered with
// it: HermesChatFeed was not memoized and every assistant bubble ran a full
// react-markdown parse inline, so ONE keystroke cost a markdown parse per
// assistant message in the conversation. AgentFeed never had this (memo'd
// Feed + TextProse memoized on the text string).
//
// This counts react-markdown renders while only an unrelated parent prop
// changes, the way a keystroke does. Rows: the recorded S12 resume
// (60 turns, hermes-headless research/corpus) through the real mapper and
// ledger. Before the fix: +N parses per keystroke (N = assistant bubbles).

const markdown = vi.hoisted(() => ({ renders: 0 }))

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  const Real = actual.default
  function CountingMarkdown(props: Parameters<typeof Real>[0]) {
    markdown.renders += 1
    return <Real {...props} />
  }
  return { ...actual, default: CountingMarkdown }
})

function recordedEntries() {
  const rows = inboundFrames(latestRecording('S12'))
    .map((frame) => (frame.result as { messages?: Record<string, unknown>[] } | undefined)?.messages)
    .filter((list): list is Record<string, unknown>[] => Array.isArray(list))
    .sort((a, b) => b.length - a.length)[0]!
  const mapper = createHermesTranscriptEntryMapper()
  return rows.flatMap((row, index) =>
    mapper.map({ hermes: 1, key: typeof row.row_id === 'number' ? `row:${row.row_id}` : `idx:${index}`, storedSessionId: 's', row }).entries)
}

/** A parent whose `draft` changes on every keystroke, like TileLeaf. */
function Pane({ runtime, draft }: { runtime: SessionRuntime; draft: string }) {
  const model = useAgentFeedModel(runtime, 'hermes', 'typing-pane')
  return (
    <div>
      <HermesChatFeed sessionId="typing-pane" items={model.ledgerFeedPlan.items} connectionName="VPS" />
      <textarea readOnly value={draft} />
    </div>
  )
}

describe('typing in a Hermes pane', () => {
  it('does not re-render the conversation on a keystroke', () => {
    const runtime = { ...emptyRuntime(), entries: recordedEntries() }
    const view = render(<Pane runtime={runtime} draft="" />)
    const assistantBubbles = view.container.querySelectorAll('[data-chat-role="assistant"]').length
    expect(assistantBubbles).toBeGreaterThan(10)
    const afterMount = markdown.renders

    for (const draft of ['h', 'he', 'hel', 'hell', 'hello']) view.rerender(<Pane runtime={runtime} draft={draft} />)

    expect(markdown.renders - afterMount).toBe(0)
  })
})
