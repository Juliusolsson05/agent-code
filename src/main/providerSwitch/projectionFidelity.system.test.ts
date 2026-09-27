import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeNativeResumeProjector,
  codexNativeResumeProjector,
  estimateConversationCharacters,
} from 'agent-transcript-parser'
import type { ConversationDocument } from 'agent-transcript-parser'

// #927: switch, duplicate and rewind must hand back what the REAL
// native-resume projector reported. The #918 B06 exit gate says a mock
// returning only `values` cannot establish this contract. So here the
// projector is the parser's own, run over recorded Stage 0 sequences, and only
// the disk edges (read, write, session id, target profile) are stubbed.

const state = vi.hoisted(() => ({
  conversation: null as ConversationDocument | null,
  written: [] as unknown[],
}))

vi.mock('node:crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000927' }))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider !== 'claude' && provider !== 'codex') throw new Error(`unexpected provider ${provider}`)
    return {
      provider,
      read: async () => state.conversation,
      targetProfile: async () => ({
        model: provider === 'claude' ? 'claude-sonnet-5' : 'gpt-5',
        modelProvider: 'openai',
        // Derived from the fixture, never a real-world budget (the fixtures
        // are value-redacted; see testing/fixtureConversations.ts).
        budgetCharacters: estimateConversationCharacters(state.conversation!) * 10,
      }),
      projectNativeResume: async (conversation: ConversationDocument, context: { cwd: string; targetSessionId: string; now: string }) => (
        provider === 'claude'
          ? claudeNativeResumeProjector.projectNativeResume(conversation, { ...context, version: '2.1.0', model: 'claude-sonnet-5' })
          : codexNativeResumeProjector.projectNativeResume(conversation, { ...context, cliVersion: '0.157.1', modelProvider: 'openai', model: 'gpt-5' })
      ),
      sessionId: () => 'new-session',
      write: async (_cwd: string, publication: unknown) => {
        state.written.push(publication)
        return '/recorded/new-session.jsonl'
      },
      draft: (content: unknown) => ({ promptText: JSON.stringify(content).slice(0, 20), promptMode: 'prompt', promptImages: [], promptAttachments: [] }),
    }
  },
}))

import { materialProjectionLoss } from '@shared/types/projectionFidelity.js'
import { duplicateSession } from './duplicateSession.js'
import { summarizeProjectionReport } from './projectionFidelity.js'
import { rewindSession } from './rewindSession.js'
import { switchProvider } from './switchProvider.js'
import { loadFixtureConversation } from './testing/fixtureConversations.js'

beforeEach(() => {
  state.written = []
})

// The fidelity a caller receives must be the summary of the projection that
// was actually WRITTEN, not of some other run.
function writtenFidelity() {
  expect(state.written).toHaveLength(1)
  return summarizeProjectionReport(state.written[0] as Parameters<typeof summarizeProjectionReport>[0])
}

describe('projection fidelity through each real caller (#927)', () => {
  // Recorded: claude-sequence-oversized -> Codex has no compaction, so the
  // context reduction reports nothing (`shrinkSummary` null, strategy
  // native), while the projector demotes 19 entries (encrypted reasoning,
  // tool-result error status). Before #927 this switch toasted as lossless.
  it('switch returns the real report even when context reduction reports nothing', async () => {
    state.conversation = await loadFixtureConversation('claude-sequence-oversized', 'claude')
    const result = await switchProvider({ sourceKind: 'claude', targetKind: 'codex', sourceProviderSessionId: 'source', cwd: '/recorded' })
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') return
    expect(result.strategy).toBe('native')
    expect(result.shrinkSummary).toBeNull()
    expect(result.projectionFidelity).toEqual(writtenFidelity())
    expect(result.projectionFidelity.codes.map(row => row.code)).toEqual(expect.arrayContaining([
      'native-resume.reasoning.encrypted-content-demoted',
      'native-resume.tool-result.error-status-demoted',
    ]))
    expect(materialProjectionLoss(result.projectionFidelity)).toBe('history: 19 demoted')
  })

  // Recorded: codex-sequence-compacted-once -> Claude drops developer messages
  // and foreign reasoning: material drops.
  it('switch names material drops in its loss line', async () => {
    state.conversation = await loadFixtureConversation('codex-sequence-compacted-once', 'codex')
    const result = await switchProvider({ sourceKind: 'codex', targetKind: 'claude', sourceProviderSessionId: 'source', cwd: '/recorded' })
    if (result.kind !== 'switched') throw new Error('expected a switch')
    expect(result.projectionFidelity).toEqual(writtenFidelity())
    expect(result.projectionFidelity.codes.map(row => row.code)).toEqual(expect.arrayContaining([
      'native-resume.message.developer.dropped',
      'native-resume.reasoning.foreign-dropped',
    ]))
    expect(materialProjectionLoss(result.projectionFidelity)).toMatch(/^history: \d+ dropped$/)
  })

  // A same-provider duplicate is not automatically lossless: Codex -> Codex
  // drops the rollout's opaque records. That loss is reported, but it is not
  // MATERIAL, so the toast stays quiet (UNCONFIRMED default).
  it('duplicate returns the report of a same-provider copy', async () => {
    state.conversation = await loadFixtureConversation('codex-sequence-compaction', 'codex')
    const result = await duplicateSession({ provider: 'codex', sourceProviderSessionId: 'source', cwd: '/recorded' })
    expect(result.projectionFidelity).toEqual(writtenFidelity())
    expect(result.projectionFidelity.codes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dropped', code: 'native-resume.opaque.dropped' }),
    ]))
    expect(materialProjectionLoss(result.projectionFidelity)).toBeNull()
  })

  it('rewind returns the report of the rewound copy', async () => {
    const conversation = await loadFixtureConversation('codex-sequence-compacted-once', 'codex')
    state.conversation = conversation
    const prompts = conversation.entries.filter(entry => entry.kind === 'message' && entry.role === 'user')
    const anchor = prompts[prompts.length - 1]!
    const result = await rewindSession({
      provider: 'codex',
      sourceProviderSessionId: 'source',
      cwd: '/recorded',
      anchor: { provider: 'codex', line: anchor.source.line!, sessionId: conversation.sourceSessionIds[0]! },
    })
    expect(result.projectionFidelity).toEqual(writtenFidelity())
    expect(result.projectionFidelity.counts.preserved).toBeGreaterThan(0)
  })
})

describe('summarizeProjectionReport on a real report', () => {
  // Recorded: claude-sequence-oversized-turns -> Codex, 485 demoted encrypted
  // reasoning blocks: enough changes of one code to exercise the line cap.
  it('groups by code, caps listed lines with an exact omitted count, and carries no prose or evidence', async () => {
    const conversation = await loadFixtureConversation('claude-sequence-oversized-turns', 'claude')
    const projection = codexNativeResumeProjector.projectNativeResume(conversation, {
      cwd: '/recorded', targetSessionId: '00000000-0000-4000-8000-000000000927', now: '2026-09-27T00:00:00.000Z',
      cliVersion: '0.157.1', modelProvider: 'openai', model: 'gpt-5',
    })
    const fidelity = summarizeProjectionReport(projection)
    expect(fidelity.codes.reduce((sum, row) => sum + row.count, 0)).toBe(projection.report.changes.length)
    expect(fidelity.counts).toEqual(projection.report.counts)
    for (const row of fidelity.codes) expect(row.sourceLines.length).toBeLessThanOrEqual(20)
    const listed = fidelity.codes.reduce((sum, row) => sum + row.sourceLines.length, 0)
    const withLines = projection.report.changes.filter(change => change.sourceLine !== null).length
    expect(listed + fidelity.sourceLinesOmitted).toBe(withLines)
    expect(fidelity.sourceLinesOmitted).toBeGreaterThan(0)
    expect(JSON.stringify(fidelity)).not.toMatch(/"message"|"evidence"/)
    expect(materialProjectionLoss(fidelity)).toMatch(/demoted/)
  })
})
