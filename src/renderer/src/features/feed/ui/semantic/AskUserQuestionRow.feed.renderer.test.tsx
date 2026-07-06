import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

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
  const block = {
    parsedInput: {
      questions: [
        {
          question: 'Pick an option',
          header: 'Choice',
          options: [{ label: 'Option A' }, { label: 'Option B' }],
        },
      ],
    },
  } as never
  // Only non-nullness gates the keyboard path; the row reads selection state
  // from its own parsed block, not from this condition snapshot.
  const live = {} as ClaudeAskUserQuestionState
  render(
    <SessionFeedProvider value={fake}>
      <CodeRenderContext.Provider value={{ sessionId: 's1', workspaceRoot: null } as never}>
        <AskUserQuestionConditionContext.Provider value={live}>
          <AskUserQuestionRow block={block} />
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
})
