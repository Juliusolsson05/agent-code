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
// continuation" row (and absorbs an empty one). The catalog listed those
// routes only for the custom-output envelope, so every plain wait result was
// reported known-misrouted (45 sightings in the 2026-08-26 audit).
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
  it('renders the recorded result as a command continuation, and the catalog permits it', () => {
    const { toolUse, toolResult } = blocksFromRecording()
    expect(toolUse.name).toBe('wait')
    const decision = renderCodexOperation({ toolUse, result: toolResult, live: false, streaming: false })
    if (decision.toolResult?.action !== 'render') throw new Error('expected a rendered continuation result')
    expect(decision.toolResult.receipt).toEqual({ rendererId: 'codex.rows.dispatch', protocolId: 'command.continuation' })
    const { fingerprint, classification, shapeId } = classify(toolResult, { kind: 'specialized', ...decision.toolResult.receipt })
    expect(fingerprint).toBe('fp2-5b0abcb6')
    expect(classification).toEqual({ kind: 'known-claimed', shapeId })
  })

  it('absorbs an empty acknowledgement of the same recorded wait, and the catalog permits it', () => {
    const { toolUse, toolResult } = blocksFromRecording()
    const empty = { ...toolResult, content: '' }
    const decision = renderCodexOperation({ toolUse, result: empty, live: false, streaming: false })
    if (decision.toolResult?.action !== 'absorb') throw new Error('expected an absorbed empty acknowledgement')
    const { fingerprint, classification, shapeId } = classify(empty, { kind: 'absorbed', rendererId: decision.toolResult.ownerRenderId, protocolId: decision.toolResult.protocolId })
    expect(fingerprint).toBe('fp2-5b0abcb6')
    expect(classification).toEqual({ kind: 'known-claimed', shapeId })
  })
})
