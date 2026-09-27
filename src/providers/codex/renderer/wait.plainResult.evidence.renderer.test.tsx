import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import fixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/committed-function-call.json'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { buildFingerprintIndex, classifySighting } from '@renderer/rendering/evidence/catalogCoverage'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// #645: Codex runs `wait` as a PLAIN function_call most of the time (3,232 in
// the local corpus), so its result is a function_call_output, which the rollout
// mapper turns into the plain tool_result envelope fp2-5b0abcb6. The dispatcher
// deliberately renders a wait result with visible output as a "Command
// continuation" row. The catalog listed that route only for the custom-output
// envelope, so every plain wait result was reported known-misrouted (45
// sightings in the 2026-08-26 audit).
//
// The empty acknowledgement route is real too, and is pinned from a second
// recording. History worth keeping: one revision of this PR REMOVED that
// route after review b of #1361 argued the mapper drops empty plain outputs so
// it could never be reached. That is true only for literally empty text. A
// still-running wait returns just the transport envelope ("Script running with
// cell ID 11 / Wall time … / Output:" and nothing after); the mapper keeps
// that (it is not empty text), and the dispatcher's visibility check, which
// strips the envelope, absorbs it. Review c counted 587 of 3,257 real plain
// wait results with that shape, all of which the removal would have turned
// back into known-misrouted. Never judge reachability from the mapper's
// empty-text branch alone; count the corpus.
const catalogIndex = buildFingerprintIndex([CODEX_RENDER_SHAPES])

function blocksFromRecording(records: unknown[] = fixture.records): { toolUse: ToolUseBlock; toolResult: ToolResultBlock } {
  const [call, output] = records.map(record => mapCodexRolloutToFeedEntries(record as Record<string, unknown>))
  // The mapper's Entry keeps `message` loosely typed; its first content block
  // is the tool block (see transcript/entries.ts codexToolUseEntry/ResultEntry).
  const firstBlock = (entries: unknown[]) => (entries[0] as { message: { content: unknown[] } }).message.content[0]
  const toolUse = firstBlock(call!) as ToolUseBlock
  const toolResult = firstBlock(output!) as ToolResultBlock
  return { toolUse, toolResult }
}

function classify(result: ToolResultBlock, outcome: { kind: 'specialized' | 'absorbed'; rendererId: string; protocolId?: string }) {
  const fingerprint = fingerprintRenderShape({ provider: 'codex', plane: 'committed-tool-result', eventType: 'tool_result', payload: result }).fingerprint
  const definition = catalogIndex.byFingerprint.get(fingerprint)
  return {
    fingerprint,
    classification: classifySighting({
      structuralFingerprint: fingerprint,
      lifecycle: 'durable',
      outcome: outcome.kind === 'specialized'
        ? { kind: 'specialized', shapeId: definition!.id, rendererId: outcome.rendererId, protocolId: outcome.protocolId }
        : { kind: 'absorbed', shapeId: definition!.id, ownerRenderId: outcome.rendererId, protocolId: outcome.protocolId },
    } as Parameters<typeof classifySighting>[0], catalogIndex),
    shapeId: definition!.id,
  }
}

describe('Codex wait with a plain function_call_output (#645)', () => {
  it('keeps the curated carrier identical to what the mapper produces from the recording', () => {
    // The catalog coverage gate reads `cases` (sweepCuratedShapeFixture), while
    // these tests read `records` through the real mapper. Pinning them equal
    // means the gate and the tests can never be looking at different shapes.
    expect(fixture.cases).toEqual([blocksFromRecording(), blocksFromRecording(fixture.emptyAcknowledgementRecords)])
  })

  it('renders the recorded result as a command continuation, and the catalog permits it', () => {
    const { toolUse, toolResult } = blocksFromRecording()
    expect(toolUse.name).toBe('wait')
    const decision = renderCodexOperation({ toolUse, result: toolResult, live: false, streaming: false })
    if (decision.toolResult?.action !== 'render') throw new Error('expected a rendered continuation result')
    expect(decision.toolResult.receipt).toEqual({ rendererId: 'codex.rows.dispatch', protocolId: 'command.continuation' })
    const { fingerprint, classification, shapeId } = classify(toolResult, { kind: 'specialized', ...decision.toolResult.receipt })
    expect(fingerprint).toBe('fp2-5b0abcb6')
    expect(classification).toEqual({ kind: 'known-claimed', shapeId })
    // The receipt alone is not the user-visible contract: a mutated label or a
    // row that dropped the recorded output kept the receipt green in review
    // (#1361 a/b). The recorded output's inner JSON must reach the screen under
    // the continuation label, with the exec wrapper stripped. The row shows a
    // JSON result collapsed as "<n> keys"; the recording's object has five.
    const output = render(decision.toolResult.node)
    expect(output.container.textContent).toContain('Command continuation')
    expect(output.container.textContent).toContain('5 keys')
    expect(output.container.textContent).not.toContain('Script completed')
    output.unmount()
  })

  it('absorbs the recorded envelope-only acknowledgement of a still-running wait, and the catalog permits it', () => {
    const { toolUse, toolResult } = blocksFromRecording(fixture.emptyAcknowledgementRecords)
    expect(toolUse.name).toBe('wait')
    // The mapper keeps it: the text is the envelope, not empty.
    expect(toolResult.content).toContain('Script running with cell ID')
    const decision = renderCodexOperation({ toolUse, result: toolResult, live: false, streaming: false })
    if (decision.toolResult?.action !== 'absorb') throw new Error('expected an absorbed empty acknowledgement')
    const { fingerprint, classification, shapeId } = classify(toolResult, {
      kind: 'absorbed',
      rendererId: decision.toolResult.ownerRenderId,
      protocolId: decision.toolResult.protocolId,
    })
    expect(fingerprint).toBe('fp2-5b0abcb6')
    expect(classification).toEqual({ kind: 'known-claimed', shapeId })
  })
})
