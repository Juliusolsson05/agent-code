import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import {
  AskUserQuestionConditionContext,
  CodeRenderContext,
} from '@renderer/features/feed/context'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

import { AskUserQuestionRow } from './AskUserQuestionRow'

// Task-6 routing proof: feed rows must send session input through the
// injected SessionFeed, not window.api — this row is shared with the remote
// client, where window.api does not exist. The arrow-key terminal-nav path
// is the cheapest real input path to drive: no headless resolver round-trip,
// just a synchronous sendInput of the escape sequence.

function renderRow(fake = createFakeSessionFeed()) {
  const input = {
    questions: [
      {
        question: 'Pick an option',
        header: 'Choice',
        options: [{ label: 'Option A' }, { label: 'Option B' }],
      },
    ],
  }
  // Only non-nullness gates the keyboard path; the row reads selection state
  // from its own parsed block, not from this condition snapshot.
  const live = {} as ClaudeAskUserQuestionState
  render(
    <SessionFeedProvider value={fake}>
      <CodeRenderContext.Provider value={{ sessionId: 's1', workspaceRoot: null } as never}>
        <AskUserQuestionConditionContext.Provider value={live}>
          <AskUserQuestionRow input={input} operationId="op1" />
        </AskUserQuestionConditionContext.Provider>
      </CodeRenderContext.Provider>
    </SessionFeedProvider>,
  )
  return fake
}

describe('AskUserQuestionRow input routing', () => {
  it('forwards terminal navigation keys through the SessionFeed', () => {
    const fake = renderRow()
    fireEvent.keyDown(screen.getByText('Pick an option'), { key: 'ArrowDown' })
    expect(fake.calls).toContainEqual({
      method: 'sendInput',
      sessionId: 's1',
      data: '\x1b[B',
      pasteId: undefined,
    })
  })

  it('answers a non-immediate Submit via Esc + prompt, not the keystroke driver', async () => {
    // Submit (multi-select / free-text / multi-question, or single-select after
    // a draft) takes the answer-via-message workaround: dismiss the picker with
    // Esc, then deliver the choices as a structured prompt — never
    // resolveCondition (the keystroke driver, kept only for immediate
    // single-select).
    const fake = renderRow()
    const input = screen.getByPlaceholderText('Type something')
    fireEvent.change(input, { target: { value: 'A custom draft' } })
    fireEvent.click(screen.getByRole('button', { name: /Option A/ }))

    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() =>
      expect(fake.calls.some(c => c.method === 'deliverPrompt')).toBe(true),
    )
    // Esc first, and it is the escape character.
    expect(fake.calls).toContainEqual({
      method: 'sendInput',
      sessionId: 's1',
      data: String.fromCharCode(27),
      pasteId: undefined,
    })
    const delivered = fake.calls.find(c => c.method === 'deliverPrompt')
    expect(delivered).toMatchObject({ method: 'deliverPrompt', sessionId: 's1' })
    expect((delivered as { prompt: string }).prompt).toContain('<selected>Option A</selected>')
    // The keystroke driver must NOT be used for this path.
    expect(fake.calls.some(c => c.method === 'resolveCondition')).toBe(false)
  })

  it('does not append an absent resolver step to an error message', async () => {
    const fake = createFakeSessionFeed()
    fake.nextResolveConditionResult = { ok: false, reason: 'no-resolver' }
    renderRow(fake)
    fireEvent.click(screen.getByRole('button', { name: /Option A/ }))
    expect(await screen.findByText('Answer failed: no-resolver')).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
  })
})
