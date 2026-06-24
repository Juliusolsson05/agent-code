import { describe, expect, it } from 'vitest'

import { sanitizeCodexRolloutForResume } from './codexResumeSanitizer'

// CodexRolloutLine is a type-only import in the module under test (erased at
// runtime), so the tests build plain line objects and cast through unknown.
type Line = { type: string; payload?: unknown }

function run(lines: Line[]): Line[] {
  return sanitizeCodexRolloutForResume(lines as never) as unknown as Line[]
}

describe('sanitizeCodexRolloutForResume', () => {
  it('drops an unresolved tool call', () => {
    const out = run([
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1' } },
    ])
    expect(out).toEqual([])
  })

  it('keeps a resolved tool call and its output', () => {
    const lines: Line[] = [
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } },
    ]
    expect(run(lines)).toEqual(lines)
  })

  it('does not throw on an array-shaped payload and treats it as a non-record', () => {
    // cross-app audit Finding 10: arrays are objects in JS but never valid Codex
    // payload records. The shared asRecord rejects them, so an array payload is
    // passed through untouched (not probed as a tool call) and nothing throws.
    const lines: Line[] = [{ type: 'response_item', payload: [] }]
    expect(run(lines)).toEqual(lines)
  })

  it('an array-shaped output payload does not resolve a dangling call', () => {
    // The array can never carry a `call_id`, so the function_call stays
    // unresolved and is dropped — the safe outcome for resume sanitization.
    const out = run([
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1' } },
      { type: 'response_item', payload: [{ type: 'function_call_output', call_id: 'c1' }] },
    ])
    expect(out).toEqual([
      { type: 'response_item', payload: [{ type: 'function_call_output', call_id: 'c1' }] },
    ])
  })
})
