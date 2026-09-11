import { expect, it } from 'vitest'

import { sessionHasTranscript } from './transcriptAvailability'

// OpenCode Terminal is kind 'opencode' but never loads transcript entries (the
// history loaders skip providerRuntime 'terminal'), so commands that read
// entries silently did nothing there. One predicate now answers for all of them.
it('answers whether a session ever has rendered transcript entries', () => {
  expect(sessionHasTranscript({ kind: 'claude' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode', providerRuntime: 'terminal' })).toBe(false)
  expect(sessionHasTranscript({ kind: 'terminal' })).toBe(false)
  expect(sessionHasTranscript({})).toBe(true) // legacy kind-less sessions were Claude
  expect(sessionHasTranscript(undefined)).toBe(false)
})
