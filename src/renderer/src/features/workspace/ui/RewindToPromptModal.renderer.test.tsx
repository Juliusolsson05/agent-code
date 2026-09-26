import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindToPromptModal } from '@renderer/features/workspace/ui/RewindToPromptModal'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { RewindPrompt } from '@shared/types/transcriptRewind'

// The modal rewinds the agent it was OPENED FOR (#1180). It used to call
// `rewindFocusedToPrompt`, which re-resolved focus at confirm time: open it
// from the Sessions row menu for an agent in no lane (or move focus while it
// is open) and it listed one agent's prompts, then rewound another agent to
// that address. The command-level table test stops at "the modal was opened
// for the target"; this pins the confirm half.
//
// Recorded workspace: focused lane shows session-17 (Codex); session-3 is a
// Claude agent in another project and in no lane — the menu's case.

const FOCUSED = 'session-17' as SessionId
const TARGET = 'session-3' as SessionId

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
})

describe('Rewind to Prompt modal', () => {
  it('rewinds the agent it was opened for, not the focused one', async () => {
    const recorded = loadRecordedDispatchWorkspace().state
    const state = {
      ...recorded,
      sessions: {
        ...recorded.sessions,
        [TARGET]: { ...recorded.sessions[TARGET]!, providerSessionId: 'provider-target' },
        [FOCUSED]: { ...recorded.sessions[FOCUSED]!, providerSessionId: 'provider-focused' },
      },
    }
    const prompt: RewindPrompt = {
      address: { provider: 'claude', line: 42, sessionId: 'provider-target', uuid: 'prompt-uuid' },
      text: 'Refactor the queue',
      timestamp: '2026-09-24T10:00:00.000Z',
    }
    const listRewindPrompts = vi.fn(async () => [prompt])
    Object.defineProperty(window, 'api', { configurable: true, value: { listRewindPrompts } })
    const rewindSessionToPrompt = vi.fn(async () => ({ status: 'completed' }))
    const rewindFocusedToPrompt = vi.fn()
    const workspace = { state, rewindSessionToPrompt, rewindFocusedToPrompt } as unknown as Workspace

    render(<RewindToPromptModal open sessionId={TARGET} workspace={workspace} onClose={vi.fn()} />)

    // Listed from the TARGET's transcript…
    await waitFor(() => { expect(screen.getByText('Refactor the queue')).toBeInTheDocument() })
    expect(listRewindPrompts).toHaveBeenCalledWith(expect.objectContaining({ sourceProviderSessionId: 'provider-target' }))
    // …and rewound on the TARGET.
    fireEvent.click(screen.getByRole('button', { name: 'Rewind Here' }))
    await waitFor(() => { expect(rewindSessionToPrompt).toHaveBeenCalledWith(TARGET, prompt.address) })
    expect(rewindFocusedToPrompt).not.toHaveBeenCalled()
  })

  it('moves focus to the listbox once prompts load, and End + Enter rewinds the oldest prompt', async () => {
    // Plan S7: the shared list keys, and the listbox (not the scroller) as
    // the focus owner even though it only appears after the async load.
    const recorded = loadRecordedDispatchWorkspace().state
    const state = {
      ...recorded,
      sessions: { ...recorded.sessions, [TARGET]: { ...recorded.sessions[TARGET]!, providerSessionId: 'provider-target' } },
    }
    const prompts: RewindPrompt[] = ['newest', 'middle', 'oldest'].map((text, index) => ({
      address: { provider: 'claude', line: 10 + index, sessionId: 'provider-target', uuid: `u${index}` },
      text,
      timestamp: '2026-09-24T10:00:00.000Z',
    }))
    Object.defineProperty(window, 'api', { configurable: true, value: { listRewindPrompts: vi.fn(async () => prompts) } })
    const rewindSessionToPrompt = vi.fn(async () => ({ status: 'completed' }))
    const workspace = { state, rewindSessionToPrompt } as unknown as Workspace

    render(<RewindToPromptModal open sessionId={TARGET} workspace={workspace} onClose={vi.fn()} />)

    const listbox = await screen.findByRole('listbox')
    await waitFor(() => { expect(document.activeElement).toBe(listbox) })
    fireEvent.keyDown(listbox, { key: 'End' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    await waitFor(() => { expect(rewindSessionToPrompt).toHaveBeenCalledWith(TARGET, prompts[2]!.address) })
  })
})

