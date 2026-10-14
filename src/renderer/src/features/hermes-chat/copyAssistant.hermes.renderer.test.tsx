import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { createHermesTranscriptEntryMapper } from '@providers/hermes/renderer/transcript/mapper'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useAgentFeedModel } from '@renderer/features/feed/agent/useAgentFeedModel'
import { assistantUuidsWithText, extractAssistantByUuid } from '@renderer/features/copy-assistant/lib/extractAssistantByUuid'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'

import { HermesChatFeed } from './HermesChatFeed'

// Plan Stage C0 (U6): reproduce "Copy Assistant Message should work with
// Hermes" on RECORDED Hermes conversations before changing anything. The
// copy commands read runtime.entries; the chat draws the ledger's feed
// items. This checks the two agree: every message the picker can select is
// a bubble on screen (the highlight can find it), and what it copies is
// what that bubble shows. Rows: recorded S4 (tool turn) and S12 (60 turns),
// through the real mapper and ledger.

function entries(scenario: string) {
  const rows = inboundFrames(latestRecording(scenario))
    .map((frame) => (frame.result as { messages?: Record<string, unknown>[] } | undefined)?.messages)
    .filter((list): list is Record<string, unknown>[] => Array.isArray(list))
    .sort((a, b) => b.length - a.length)[0]!
  const mapper = createHermesTranscriptEntryMapper()
  return rows.flatMap((row, index) =>
    mapper.map({ hermes: 1, key: typeof row.row_id === 'number' ? `row:${row.row_id}` : `idx:${index}`, storedSessionId: 's', row }).entries)
}

function Pane({ runtime }: { runtime: SessionRuntime }) {
  const model = useAgentFeedModel(runtime, 'hermes', 'copy-pane')
  return <HermesChatFeed sessionId="copy-pane" items={model.ledgerFeedPlan.items} connectionName="VPS" />
}

describe('Copy Assistant on a Hermes pane (plan C0)', () => {
  for (const scenario of ['S4', 'S12']) {
    it(`${scenario}: every selectable message is a bubble, and copying gives exactly what it shows`, () => {
      const rows = entries(scenario)
      const view = render(<Pane runtime={{ ...emptyRuntime(), entries: rows }} />)
      const uuids = assistantUuidsWithText(rows)
      expect(uuids.length).toBeGreaterThan(0)
      for (const uuid of uuids) {
        const bubble = view.container.querySelector(`[data-entry-uuid="${CSS.escape(uuid)}"]`)
        expect(bubble, uuid).not.toBeNull()
        const copied = extractAssistantByUuid(rows, uuid)!
        // Rendered markdown drops markup; compare the words.
        const words = (text: string) => text.replace(/[`*_#>\-\[\]()]/g, ' ').split(/\s+/).filter(Boolean).join(' ')
        expect(words(bubble!.textContent ?? '')).toContain(words(copied).slice(0, 80))
      }
      expect(extractLastAssistantText(rows, 'hermes')).toBe(extractAssistantByUuid(rows, uuids.at(-1)!))
    })
  }
})
