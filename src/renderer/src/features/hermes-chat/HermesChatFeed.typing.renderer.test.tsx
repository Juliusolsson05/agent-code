import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { createHermesTranscriptEntryMapper } from '@providers/hermes/renderer/transcript/mapper'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useAgentFeedModel } from '@renderer/features/feed/agent/useAgentFeedModel'

import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'

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

function recordedEntries(scenario = 'S12') {
  const rows = inboundFrames(latestRecording(scenario))
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

// The owner's debug bundle (2026-10-14T16-26-49): 206 tool chips + 136
// reasoning blocks kept 394 KB of bodies mounted inside CLOSED <details>
// (3,917 elements), and each Hermes send froze the window 2-5.7 s. A closed
// body is never seen, so it must not be in the DOM. Rows: recorded S4 (a
// tool turn) through the real mapper and ledger.
describe('collapsed chat rows', () => {
  it('builds a tool chip body only when it is opened', () => {
    const view = render(<Pane runtime={{ ...emptyRuntime(), entries: recordedEntries('S4') }} draft="" />)
    const chips = view.container.querySelectorAll<HTMLDetailsElement>('[data-chat-role="tool"]')
    expect(chips.length).toBeGreaterThan(0)
    expect(view.container.querySelectorAll('[data-chat-role="tool"] pre')).toHaveLength(0)
    chips[0]!.open = true
    fireEvent(chips[0]!, new Event('toggle'))
    expect(chips[0]!.querySelectorAll('pre').length).toBeGreaterThan(0)
  })

  // Owner report 2026-10-14: an opened chip drew its multi-line body inside
  // the pill (9999px radius) and the curve cut through the text.
  it('is a pill only while closed; opened, it takes the bubble radius', () => {
    const view = render(<Pane runtime={{ ...emptyRuntime(), entries: recordedEntries('S4') }} draft="" />)
    const chip = view.container.querySelector<HTMLDetailsElement>('[data-chat-role="tool"]')!
    expect(chip.className).toContain('rounded-chip')
    chip.open = true
    fireEvent(chip, new Event('toggle'))
    expect(chip.className).not.toContain('rounded-chip')
    expect(chip.className).toContain('rounded-slab')
  })
})

// The owner, 2026-10-14: "as soon as I go into spotlight with Hermes,
// performance becomes horrendous". Spotlight shows a second live copy of the
// pane and keeps the lane's copy mounted under display:none (#752). Both
// re-rendered on every update. Harness: the two copies, the hidden one inside
// the same visibility provider Spotlight uses. One new reply arrives.
describe('a Hermes pane in Spotlight', () => {
  it('lets the hidden copy do no work while the visible one renders only the new reply', () => {
    const entries = recordedEntries()
    const assistant = entries.filter((entry) => entry.type === 'assistant').at(-1)!
    const reply = { ...assistant, uuid: 'hermes:row:new', message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'A brand new reply.' }] } }
    const before = { ...emptyRuntime(), entries }
    const after = { ...emptyRuntime(), entries: [...entries, reply] }
    const Spotlight = ({ runtime }: { runtime: SessionRuntime }) => (
      <>
        <Pane runtime={runtime} draft="" />
        <AgentTerminalOwnerVisibilityProvider visible={false}>
          <Pane runtime={runtime} draft="" />
        </AgentTerminalOwnerVisibilityProvider>
      </>
    )
    const view = render(<Spotlight runtime={before} />)
    const mounted = markdown.renders
    view.rerender(<Spotlight runtime={after} />)
    expect(markdown.renders - mounted).toBe(1)
  })
})

// Owner report 2026-10-14: replies sat in a filled bubble nearly the same grey
// as the user's prompts. Only the prompt is tinted now. Rows: recorded S4.
describe('who said what', () => {
  it('tints the user prompt and leaves replies on the pane background', () => {
    const view = render(<Pane runtime={{ ...emptyRuntime(), entries: recordedEntries('S4') }} draft="" />)
    const user = view.container.querySelector('[data-chat-role="user"] > div')!
    const reply = view.container.querySelector('[data-chat-role="assistant"] > div')!
    expect(user.className).toContain('bg-user-bg')
    expect(reply.className).not.toMatch(/\bbg-/)
  })
})
