import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderClaudeDurableEntry } from '@providers/claude/renderer/entries/dispatch'
import { renderCodexDurableEntry } from '@providers/codex/renderer/entries/dispatch'
import type { Entry } from '@shared/types/transcript'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/features/feed/ledger/ledgerFeedItems'
import { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
import { ProviderContext } from '@renderer/features/feed/context'
import finalFixture from '../../../../../../testing/fixtures/rendering-shapes/codex/compaction/semantic-final.json'
import prefixFixture from '../../../../../../testing/fixtures/rendering-shapes/codex/compaction/semantic-prefix.json'

const boundary: Entry = {
  uuid: 'compact-boundary-1',
  timestamp: '2026-07-17T12:00:00.000Z',
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
}
const summary: Entry = {
  uuid: 'compact-summary-1',
  timestamp: '2026-07-17T12:00:01.000Z',
  type: 'user',
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: [{ type: 'text', text: 'Durable summary evidence' }] },
}

describe('provider-owned durable compaction entries', () => {
  it.each([
    ['claude', renderClaudeDurableEntry],
    ['codex', renderCodexDurableEntry],
  ] as const)('renders %s boundary and summary from entries alone', async (_provider, dispatch) => {
    const boundaryDecision = dispatch({ entry: boundary })
    const summaryDecision = dispatch({ entry: summary })
    expect(boundaryDecision?.receipt.protocolId).toBe('compaction.boundary')
    expect(summaryDecision?.receipt.protocolId).toBe('compaction.summary')
    render(<>{boundaryDecision?.node}{summaryDecision?.node}</>)
    expect(screen.getByText('Conversation compacted')).toBeInTheDocument()
    // Compaction intentionally uses the lazy prose boundary so importing the
    // capability registry does not pull Markdown/DOM machinery into headless
    // graphs. The heading is synchronous; body paint follows module admission.
    expect(await screen.findByText('Durable summary evidence')).toBeInTheDocument()
  })

  it('declines ordinary entries instead of teaching the shared feed provider vocabulary', () => {
    const ordinary: Entry = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }
    expect(renderClaudeDurableEntry({ entry: ordinary })).toBeUndefined()
    expect(renderCodexDurableEntry({ entry: ordinary })).toBeUndefined()
  })

  it.each(['claude', 'codex'] as const)(
    'replays %s durable compaction through runtime, ledger, bridge, and provider paint with no condition state',
    async provider => {
      const replay = () => {
        // A fresh runtime + adapter + ledger models application restart: only
        // durable entries survive. No condition snapshot or screen parser state
        // is supplied anywhere in this path.
        const runtime = emptyRuntime()
        runtime.entries = [boundary, summary]
        runtime.conditions = null
        const slices = {
          provider,
          sessionId: `replay-${provider}`,
          entries: runtime.entries,
          semanticCurrent: null,
          semanticHistory: [],
          ghosts: new Map(),
          streamPhase: 'idle',
          lastJsonlEntryAtMs: Date.parse('2026-07-17T12:00:01.000Z'),
        } as const
        const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
        return ledgerToFeedItems(
          ledger,
          ledgerFeedContextFromRuntime(runtime, provider),
        )
      }

      for (let boot = 0; boot < 2; boot += 1) {
        const { items, dropped } = replay()
        expect(dropped).toEqual([])
        const entries = items.filter(item => item.type === 'entry')
        expect(entries).toHaveLength(2)
        const view = render(
          <ProviderContext.Provider value={provider}>
            {entries.map(item =>
              item.type === 'entry' ? <EntryRow key={item.key} entry={item.entry} /> : null,
            )}
          </ProviderContext.Provider>,
        )
        expect(screen.getByText('Conversation compacted')).toBeInTheDocument()
        expect(await screen.findByText('Durable summary evidence')).toBeInTheDocument()
        view.unmount()
      }
    },
  )

  it.each([
    [prefixFixture.semanticBlock, 'prefix', 'fp2-4a35edef', 'Compacting conversation…'],
    [finalFixture.semanticBlock, 'input-complete', 'fp2-4016d91b', 'Conversation compacted'],
  ] as const)('renders the captured Codex structured compaction fixture (%s)', (semanticBlock, lifecycle, expectedFingerprint, label) => {
    const fingerprint = fingerprintRenderShape({
      provider: 'codex',
      plane: 'semantic-tool',
      eventType: 'compaction',
      payload: semanticBlock,
    })
    expect(fingerprint.fingerprint).toBe(expectedFingerprint)
    const finalized = 'finalized' in semanticBlock && semanticBlock.finalized === true
    expect(lifecycle).toBe(finalized ? 'input-complete' : 'prefix')
    const decision = renderCodexSemanticBlock(
      semanticBlock as import('@renderer/session-runtime/state').SemanticLiveBlock,
      { committedToolResults: new Map() },
    )
    expect(decision?.action).toBe('render')
    if (decision?.action !== 'render') return
    expect(decision.receipt).toEqual({
      rendererId: 'shared.compaction',
      protocolId: 'compaction.live',
    })
    render(<>{decision.node}</>)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
