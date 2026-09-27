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
// WHY there is no absorbed (empty acknowledgement) route for THIS envelope: the
// rollout mapper drops a plain function_call_output whose text is empty or only
// the exec wrapper (transcript/rollout.ts, `!output.trim()`), so an empty plain
// wait result never reaches the dispatcher. An earlier revision catalogued the
// absorb route anyway and "proved" it with a hand-built empty block; review
// (#1361 b) showed that route has no real source, and a catalog alternate
// without evidence only hides a future misroute. The last test pins the drop,
// so if the mapper ever starts keeping empty plain outputs, this test fails
// and the absorb route must be catalogued from a recording then.
const catalogIndex = buildFingerprintIndex([CODEX_RENDER_SHAPES])

function blocksFromRecording(): { toolUse: ToolUseBlock; toolResult: ToolResultBlock } {
  const [call, output] = fixture.records.map(record => mapCodexRolloutToFeedEntries(record as Record<string, unknown>))
  // The mapper's Entry keeps `message` loosely typed; its first content block
  // is the tool block (see transcript/entries.ts codexToolUseEntry/ResultEntry).
  const firstBlock = (entries: unknown[]) => (entries[0] as { message: { content: unknown[] } }).message.content[0]
  const toolUse = firstBlock(call!) as ToolUseBlock
  const toolResult = firstBlock(output!) as ToolResultBlock
  return { toolUse, toolResult }
}

function classify(result: ToolResultBlock, outcome: { rendererId: string; protocolId?: string }) {
  const fingerprint = fingerprintRenderShape({ provider: 'codex', plane: 'committed-tool-result', eventType: 'tool_result', payload: result }).fingerprint
  const definition = catalogIndex.byFingerprint.get(fingerprint)
  return {
    fingerprint,
    classification: classifySighting({
      structuralFingerprint: fingerprint,
      lifecycle: 'durable',
      outcome: { kind: 'specialized', shapeId: definition!.id, rendererId: outcome.rendererId, protocolId: outcome.protocolId },
    } as Parameters<typeof classifySighting>[0], catalogIndex),
    shapeId: definition!.id,
  }
}

describe('Codex wait with a plain function_call_output (#645)', () => {
  it('renders the recorded result as a command continuation, and the catalog permits it', () => {
    const { toolUse, toolResult } = blocksFromRecording()
    expect(toolUse.name).toBe('wait')
    const decision = renderCodexOperation({ toolUse, result: toolResult, live: false, streaming: false })
    if (decision.toolResult?.action !== 'render') throw new Error('expected a rendered continuation result')
    expect(decision.toolResult.receipt).toEqual({ rendererId: 'codex.rows.dispatch', protocolId: 'command.continuation' })
    const { fingerprint, classification, shapeId } = classify(toolResult, decision.toolResult.receipt)
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

  it('never commits an empty plain acknowledgement, so no absorb route is catalogued for it', () => {
    const [call, output] = fixture.records
    const emptyOutput = { ...output, payload: { ...output!.payload, output: '' } }
    expect(mapCodexRolloutToFeedEntries(call as Record<string, unknown>)).toHaveLength(1)
    expect(mapCodexRolloutToFeedEntries(emptyOutput as Record<string, unknown>)).toEqual([])
    const absorbedPlain = CODEX_RENDER_SHAPES['codex.tool-result.tool-result.v1']!.alternateDispositions!
      .filter(route => route.kind === 'absorbed' && route.protocolId === 'command.continuation' && route.ownerRendererId === 'codex.rows.dispatch')
    expect(absorbedPlain).toEqual([])
  })
})
