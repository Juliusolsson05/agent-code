import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  LiveUnresolvedQuestionsContext,
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { Block } from '@renderer/features/feed/ui/rows/Block'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

describe('Claude provider-owned committed question', () => {
  it('renders question and answer once through provider dispatch', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: {
        questions: [{
          question: 'Continue the rewrite?',
          header: 'Phase 8',
          options: [{ label: 'Yes' }, { label: 'No' }],
        }],
      },
    }
    const result: ToolResultBlock = {
      type: 'tool_result', tool_use_id: use.id, content: 'Yes',
    }
    render(
      <ProviderContext.Provider value="claude">
        <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
          <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
            <Block block={use} role="assistant" />
            <Block block={result} role="user" />
          </ToolResultIndexContext.Provider>
        </ToolUseIndexContext.Provider>
      </ProviderContext.Provider>,
    )

    expect(screen.getByText('Question')).toBeInTheDocument()
    expect(screen.getByText('Continue the rewrite?')).toBeInTheDocument()
    expect(screen.getByText('Yes · No')).toBeInTheDocument()
    expect(screen.getAllByText('Yes')).toHaveLength(1)
  })

  it('does not describe a missing durable answer as a proven live picker', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'unanswered', name: 'AskUserQuestion', input: {
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    }
    render(
      <ProviderContext.Provider value="claude">
        <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
          <ToolResultIndexContext.Provider value={new Map()}>
            <Block block={use} role="assistant" />
          </ToolResultIndexContext.Provider>
        </ToolUseIndexContext.Provider>
      </ProviderContext.Provider>,
    )
    expect(screen.getByText('no answer recorded')).toBeInTheDocument()
    expect(screen.queryByText(/live picker/)).not.toBeInTheDocument()
  })

  // #738: the ledger hands the tool_use to this committed row as soon as the
  // JSONL entry lands, which Claude writes BEFORE it runs the picker. While
  // the semantic plane still holds the question unresolved in the current
  // turn, the committed card must BE the picker, not describe its absence.
  it('renders the interactive picker while the live plane holds the question unresolved', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'pending', name: 'AskUserQuestion', input: {
        questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'Later' }] }],
      },
    }
    render(
      <SessionFeedProvider value={createFakeSessionFeed()}>
        <ProviderContext.Provider value="claude">
          <LiveUnresolvedQuestionsContext.Provider value={new Set(['pending'])}>
            <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
              <ToolResultIndexContext.Provider value={new Map()}>
                <Block block={use} role="assistant" />
              </ToolResultIndexContext.Provider>
            </ToolUseIndexContext.Provider>
          </LiveUnresolvedQuestionsContext.Provider>
        </ProviderContext.Provider>
      </SessionFeedProvider>,
    )
    // The option buttons are the interactive surface; the view-only card
    // renders the labels as plain "Yes · Later" text instead.
    expect(screen.getByRole('button', { name: /Later/ })).toBeInTheDocument()
    expect(screen.queryByText('Yes · Later')).not.toBeInTheDocument()
    expect(screen.queryByText('no answer recorded')).not.toBeInTheDocument()
  })

  it('stays view-only once a durable result exists even if the live set still lists the id', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'settled', name: 'AskUserQuestion', input: {
        questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'Later' }] }],
      },
    }
    const result: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: 'Yes' }
    render(
      <ProviderContext.Provider value="claude">
        <LiveUnresolvedQuestionsContext.Provider value={new Set(['settled'])}>
          <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
            <ToolResultIndexContext.Provider value={new Map([[use.id, result]])}>
              <Block block={use} role="assistant" />
            </ToolResultIndexContext.Provider>
          </ToolUseIndexContext.Provider>
        </LiveUnresolvedQuestionsContext.Provider>
      </ProviderContext.Provider>,
    )
    expect(screen.queryByRole('button', { name: /Later/ })).not.toBeInTheDocument()
    expect(screen.getByText('Answer')).toBeInTheDocument()
  })

  it('stays view-only when the id is not live-unresolved (reload with no semantic evidence)', () => {
    const use: ToolUseBlock = {
      type: 'tool_use', id: 'stale', name: 'AskUserQuestion', input: {
        questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }] }],
      },
    }
    render(
      <ProviderContext.Provider value="claude">
        <LiveUnresolvedQuestionsContext.Provider value={new Set(['some-other-id'])}>
          <ToolUseIndexContext.Provider value={new Map([[use.id, use]])}>
            <ToolResultIndexContext.Provider value={new Map()}>
              <Block block={use} role="assistant" />
            </ToolResultIndexContext.Provider>
          </ToolUseIndexContext.Provider>
        </LiveUnresolvedQuestionsContext.Provider>
      </ProviderContext.Provider>,
    )
    expect(screen.queryByRole('button', { name: /Yes/ })).not.toBeInTheDocument()
    expect(screen.getByText('no answer recorded')).toBeInTheDocument()
  })
})
