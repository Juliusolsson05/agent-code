import { describe, expect, it } from 'vitest'

import type { PasteDebugSession } from '@preload/api/types'
import { buildLifecycle } from './timeline.js'

const session = (events: PasteDebugSession['events']): PasteDebugSession => ({
  pasteId: 'paste-1',
  startedAt: 1,
  events,
})

describe('Claude paste debug lifecycle', () => {
  it('requires durable acceptance before classifying writes as submitted', () => {
    expect(buildLifecycle(session([
      { layer: 'IPC', event: 'write:paste-and-submit-single', ts: 2, tMs: 1 },
    ])).outcome).toBe('pending')
  })

  it('lets durable acceptance outrank a later renderer error', () => {
    expect(buildLifecycle(session([
      { layer: 'PTY', event: 'delivery:acceptance-user', ts: 2, tMs: 1 },
      { layer: 'ERROR', event: 'submit:throw', ts: 3, tMs: 2 },
    ])).outcome).toBe('submitted')
  })
})
