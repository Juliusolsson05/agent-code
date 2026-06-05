import { describe, it, expect } from 'vitest'

import { applyPromptSuggestionToRuntime } from '@renderer/workspace/hook/ipc/applyPromptSuggestionToRuntime'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

// We don't need a full runtime — the helper touches exactly one field. Cast a
// minimal object so the test stays focused and doesn't depend on emptyRuntime
// pulling in heavy renderer deps.
const base = { promptSuggestion: null } as unknown as SessionRuntime

describe('applyPromptSuggestionToRuntime', () => {
  it('stores trimmed suggestion text + receivedAt', () => {
    const next = applyPromptSuggestionToRuntime(base, { text: '  run the tests  ', ts: 5 })
    expect(next.promptSuggestion).toEqual({ text: 'run the tests', receivedAt: 5 })
  })

  it('returns the SAME reference for empty/whitespace text (no-op short-circuit)', () => {
    expect(applyPromptSuggestionToRuntime(base, { text: '   ' })).toBe(base)
    expect(applyPromptSuggestionToRuntime(base, {})).toBe(base)
  })

  it('defaults receivedAt to 0 when ts is missing', () => {
    const next = applyPromptSuggestionToRuntime(base, { text: 'commit this' })
    expect(next.promptSuggestion).toEqual({ text: 'commit this', receivedAt: 0 })
  })
})
