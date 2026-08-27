import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderClaudeDurableEntry } from '@providers/claude/renderer/entries/dispatch'
import { classifyClaudeDurableEntry } from '@providers/claude/renderer/entries/classify'
import { createClaudeTranscriptEntryMapper } from '@providers/claude/renderer/transcript/mapper'
import { ledgerFeedContextFromRuntime, ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
import { ProviderContext } from '@renderer/features/feed/context'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'
import recordedShapes from '../../../../../testing/fixtures/rendering-shapes/claude/queued-command/final.json'

type RenderingBundle = {
  input: {
    entries: Record<string, unknown>[]
  }
}

function bundle(name: string): RenderingBundle {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'testing', 'fixtures', 'rendering-bundles', name),
      'utf8',
    ),
  ) as RenderingBundle
}

const missingBubbleBundle = bundle('2026-06-14T14-25-07-012-a8ad1ebb.json')
const notificationBundle = bundle('2026-06-21T20-14-23-131-62432945.json')

// These indices are part of the recorded contract, not convenient examples:
// each prompt attachment follows a real enqueue/remove pair carrying the same
// content, and none has a matching conversation-user row in the bundle.
const recordedPromptAttachments = [13, 30, 70].map(
  index => missingBubbleBundle.input.entries[index] as Entry,
)
const recordedTaskNotification =
  notificationBundle.input.entries[43] as Entry
const recordedBlockArray = recordedShapes.humanBlockArray as Entry
const recordedPeerMeta = recordedShapes.peerMeta as Entry

function replay(entries: Entry[]) {
  const runtime = emptyRuntime()
  runtime.entries = entries
  const slices = {
    provider: 'claude' as const,
    sessionId: 'recorded-queued-command',
    entries,
    semanticCurrent: null,
    semanticHistory: [],
    ghosts: new Map(),
    streamPhase: 'idle',
    lastJsonlEntryAtMs: null,
  }
  const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
  return {
    runtime,
    ledger,
    bridged: ledgerToFeedItems(
      ledger,
      ledgerFeedContextFromRuntime(runtime, 'claude'),
    ),
  }
}

describe('recorded Claude queued-command attachments', () => {
  it('admits each durable human prompt through mapper, classifier, and ledger', () => {
    const mapper = createClaudeTranscriptEntryMapper()

    for (const attachment of recordedPromptAttachments) {
      const mapped = mapper.map(attachment as Record<string, unknown>)
      expect(mapped.entries).toEqual([attachment])
      expect(classifyClaudeDurableEntry(attachment)).toBe('queued-user-prompt')

      const committed = collectCommittedCandidates(
        [attachment],
        'claude',
        'recorded-queued-command',
      )
      expect(committed.candidates).toEqual([
        expect.objectContaining({
          id: `entry:${attachment.uuid}`,
          owner: 'committed',
          sourcePlane: 'committed',
          contentKind: 'user-text',
        }),
      ])
      expect(committed.decisions).toEqual([
        expect.objectContaining({
          candidateId: `entry:${attachment.uuid}`,
          selected: true,
        }),
      ])
    }
  })

  it('replays the original durable entries with stable identity and no bridge drops', () => {
    const { bridged } = replay(recordedPromptAttachments)
    expect(bridged.dropped).toEqual([])
    expect(
      bridged.items
        .filter(item => item.type === 'entry')
        .map(item => item.type === 'entry' ? item.entry.uuid : null),
    ).toEqual(recordedPromptAttachments.map(entry => entry.uuid))
  })

  it('paints the recorded block-array prompt as a user row without flattening its image', () => {
    expect(classifyClaudeDurableEntry(recordedBlockArray)).toBe('queued-user-prompt')
    const decision = renderClaudeDurableEntry({ entry: recordedBlockArray })
    expect(decision?.receipt).toEqual({
      rendererId: 'claude.queued-user-prompt',
      protocolId: 'queued-command.prompt',
    })

    const replayed = replay([recordedBlockArray])
    expect(replayed.bridged.dropped).toEqual([])
    const entries = replayed.bridged.items.filter(item => item.type === 'entry')
    render(
      <ProviderContext.Provider value="claude">
        {entries.map(item =>
          item.type === 'entry'
            ? <EntryRow key={item.key} entry={item.entry} />
            : null,
        )}
      </ProviderContext.Provider>,
    )
    expect(screen.getByText('RECORDED_BLOCK_TEXT')).toBeInTheDocument()
    // Redaction deliberately replaces the real base64 payload, so the shared
    // image row presents its bounded fallback receipt instead of an <img>.
    // Seeing that receipt proves the image block survived as a block; a
    // flatten-to-string adapter would have lost this second row entirely.
    expect(screen.getByText(/Pasted image · image\/png/)).toBeInTheDocument()
  })

  it('does not admit recorded task-notification or peer/meta attachments as user prompts', () => {
    const mapper = createClaudeTranscriptEntryMapper()

    for (const attachment of [recordedTaskNotification, recordedPeerMeta]) {
      expect(classifyClaudeDurableEntry(attachment)).not.toBe('queued-user-prompt')
      expect(mapper.map(attachment as Record<string, unknown>).entries).toEqual([])
      expect(
        collectCommittedCandidates(
          [attachment],
          'claude',
          'recorded-queued-command',
        ).candidates,
      ).toEqual([])
    }
  })
})
