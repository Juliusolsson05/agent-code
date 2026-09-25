import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { replyToSelectionCommands } from '@renderer/features/reply-to-selection/commands/replyToSelectionCommands'
import { prefixDraftWithQuote } from '@renderer/features/reply-to-selection/lib/formatQuote'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { Entry } from '@shared/types/transcript'

// "Reply to Reader Message" (ledger K2-4, steering k11). It is the keyboard
// path to quoting, because Reply to Selection needs a mouse text selection.
// These tests pin the target invariant:
//   - the quote lands in the composer of the agent being READ;
//   - that agent's draft is kept beneath the quote;
//   - nothing is sent;
//   - every other agent's draft is untouched;
//   - with no selected message the command is unavailable, and running it
//     anyway does nothing.
// The real ReaderView publishes the selection, and the real catalog command
// consumes it.
//
// Fixture: two assistant entries in the transcript Entry shape that
// ReaderView's own suite uses. The quote contract is text-agnostic.

const assistantEntry = (uuid: string, text: string): Entry =>
  ({ type: 'assistant', uuid, message: { role: 'assistant', content: text } }) as Entry

const command = replyToSelectionCommands.find(c => c.id === 'reply-to-reader-message')!

function harness({ readerOpen = true, entries }: { readerOpen?: boolean; entries?: Entry[] } = {}) {
  const drafts: Record<string, string> = { 'session-1': 'my half-written reply', 'session-2': 'other agent draft' }
  const runtimes: Record<string, SessionRuntime> = {
    'session-1': { ...emptyRuntime(), entries: entries ?? [assistantEntry('older', 'Older answer'), assistantEntry('newer', 'Newer answer')] },
    'session-2': { ...emptyRuntime(), entries: [assistantEntry('b', 'Agent B answer')] },
  }
  const tab = { id: 'tab-1', title: 'Project' }
  const setDraftInput = vi.fn((sessionId: string, draft: string) => { drafts[sessionId] = draft })
  const sendPrompt = vi.fn()
  const submitDraft = vi.fn()
  const workspace = {
    state: {
      activeTabId: tab.id,
      tabs: [tab],
      sessions: {
        'session-1': { cwd: '/project', title: 'Agent A', kind: 'claude', projectId: 'tab-1', joinedAt: 0 },
        'session-2': { cwd: '/project', title: 'Agent B', kind: 'claude', projectId: 'tab-1', joinedAt: 0 },
      },
      pinnedSessionIds: [],
      stage: oneLaneStage('session-2'),
    },
    activeTab: tab,
    stage: oneLaneStage('session-2'),
    // Reader reads session-1 while the hidden grid focuses session-2: the
    // quote must follow the READER.
    readerMode: readerOpen ? { tabId: tab.id, focusedSessionId: 'session-1' } : null,
    getRuntime: (id: string) => ({ ...runtimes[id]!, draftInput: drafts[id] ?? '' }),
    setReaderModeSession: vi.fn(),
    setDraftInput,
    showPaneToast: vi.fn(),
    sendPrompt,
    submitDraft,
  } as unknown as Workspace
  const ctx = { workspace } as unknown as CommandContext
  return { workspace, ctx, drafts, setDraftInput, sendPrompt, submitDraft }
}

afterEach(() => { document.body.replaceChildren() })

describe('Reply to Reader Message', () => {
  it("quotes the Reader's selected message into THAT agent's composer, keeps its draft, sends nothing", () => {
    const h = harness()
    render(<ReaderView workspace={h.workspace} />)
    // Pick the older message from the keyboard, as a keyboard user would.
    fireEvent.keyDown(document, { altKey: true, code: 'ArrowUp', key: 'ArrowUp' })

    expect(command.when!(h.ctx)).toBe(true)
    command.run(h.ctx)

    expect(h.drafts['session-1']).toBe(prefixDraftWithQuote('my half-written reply', 'Older answer').draft)
    expect(h.drafts['session-1']).toContain('my half-written reply')
    expect(h.drafts['session-2']).toBe('other agent draft')
    expect(h.setDraftInput).toHaveBeenCalledTimes(1)
    expect(h.sendPrompt).not.toHaveBeenCalled()
    expect(h.submitDraft).not.toHaveBeenCalled()
  })

  it('is unavailable, and a stray run is a no-op, when Reader shows no message', () => {
    const h = harness({ entries: [] })
    render(<ReaderView workspace={h.workspace} />)
    expect(command.when!(h.ctx)).toBe(false)
    command.run(h.ctx)
    expect(h.setDraftInput).not.toHaveBeenCalled()
  })

  it('is unavailable once Reader closes, even though the last message was published', () => {
    const open = harness()
    const view = render(<ReaderView workspace={open.workspace} />)
    expect(command.when!(open.ctx)).toBe(true)
    // Reader mode already off in the store while the publication still
    // stands (the stash outlives the reader for a commit): not quotable.
    const closed = harness({ readerOpen: false })
    expect(command.when!(closed.ctx)).toBe(false)
    command.run(closed.ctx)
    expect(closed.setDraftInput).not.toHaveBeenCalled()
    // And the unmount clears the publication itself.
    view.unmount()
    expect(command.when!(open.ctx)).toBe(false)
  })
})
