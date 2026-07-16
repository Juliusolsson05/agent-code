import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import type { Entry } from '@shared/types/transcript'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'

import type { PresentationNode } from '@renderer/features/feed/presentation/types'

import { PresentationRow, presentationRowPropsEqual } from './PresentationRow'

const ORDER = {
  phase: 'content' as const,
  timeMs: 1,
  sequence: 1,
  source: 'presentation-row-memo-test',
}

function committedItem(index: number): FeedRenderItem {
  const entry = {
    type: 'assistant',
    uuid: `assistant-${index}`,
    parentUuid: null,
    message: { role: 'assistant', content: `restored message ${index}` },
  } as Entry
  return {
    type: 'entry',
    key: `entry:assistant-${index}`,
    entry,
    entryOrdinal: index,
    visibleDecision: {
      key: `entry:assistant-${index}`,
      entry,
      visible: true,
      reason: 'conversation',
    },
    order: { ...ORDER, sequence: index },
  }
}

function liveText(text: string): FeedRenderItem {
  return {
    type: 'semantic-block',
    key: 'semantic:live-text',
    turnId: 'live-turn',
    owner: 'semantic-current',
    block: {
      blockIndex: 0,
      kind: 'text',
      text,
      finalized: false,
    },
    toolState: null,
    order: { ...ORDER, sequence: 1_000 },
  }
}

describe('PresentationRow semantic memo boundary', () => {
  it('keeps 200 restored siblings cold while the active text advances', () => {
    const committed = Array.from({ length: 200 }, (_, index) => committedItem(index))
    const project = (text: string) => projectFeedPresentation({
      items: [...committed, liveText(text)],
      provider: 'claude',
      toolUseIndex: new Map(),
      toolResultIndex: new Map(),
    }).nodes

    const before = project('token')
    const after = project('token stream advanced')
    const props = (node: (typeof before)[number]) => ({
      node,
      turnStartedAt: null,
      toolHint: null,
    })

    for (let index = 0; index < 200; index += 1) {
      expect(presentationRowPropsEqual(props(before[index]!), props(after[index]!))).toBe(true)
    }
    expect(presentationRowPropsEqual(props(before[200]!), props(after[200]!))).toBe(false)
  })

  it('renders citation titles, targets, and useful source excerpts', () => {
    const node: PresentationNode = {
      kind: 'message',
      id: 'message-with-citation',
      sourceKeys: ['semantic:citation'],
      order: ORDER,
      sourceGroupId: 'turn:citation',
      entryUuid: null,
      entryOrdinal: null,
      role: 'assistant',
      text: 'A sourced answer.',
      streaming: false,
      citations: [{
        url: 'https://example.test/source',
        title: 'Renderer source',
        cited_text: 'The relevant source excerpt.',
      }],
    }

    render(<PresentationRow node={node} turnStartedAt={null} toolHint={null} />)

    expect(screen.getByRole('link', { name: 'Renderer source' }).getAttribute('href')).toBe(
      'https://example.test/source',
    )
    expect(screen.getByText('The relevant source excerpt.')).toBeTruthy()
  })
})
