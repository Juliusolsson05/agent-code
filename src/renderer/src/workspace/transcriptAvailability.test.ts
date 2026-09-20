import { expect, it } from 'vitest'

import { sessionHasTranscript } from './transcriptAvailability'

// OpenCode Terminal is kind 'opencode' and, since #882's Stage 6, DOES carry
// rendered transcript entries: the history loader and the durable committed
// stream populate `runtime.entries` exactly like every other agent. One
// predicate answers "can transcript-reading commands trust this session" for
// all of them; the pane-surface question (may the rendered FEED mount) is a
// different contract owned by getEffectiveAgentSurface's terminal pin.
it('answers whether a session ever has rendered transcript entries', () => {
  expect(sessionHasTranscript({ kind: 'claude' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'opencode', providerRuntime: 'terminal' })).toBe(true)
  expect(sessionHasTranscript({ kind: 'terminal' })).toBe(false)
  expect(sessionHasTranscript({})).toBe(true) // legacy kind-less sessions were Claude
  expect(sessionHasTranscript(undefined)).toBe(false)
})
