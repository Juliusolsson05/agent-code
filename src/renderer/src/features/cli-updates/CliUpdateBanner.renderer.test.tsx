import { describe, expect, it } from 'vitest'

import { describeState } from './CliUpdateBanner'

const deferred = { kind: 'deferred' as const, cli: 'claude' as const, from: '2.1.281', wantedLatest: '2.1.282', reason: 'session-active' as const, checkedAt: 1 }

describe('CliUpdateBanner deferred state (#1243)', () => {
  it('explains a deferral of the user\'s own click, with what to do', () => {
    expect(describeState('claude', { ...deferred, requestedByUser: true })?.text)
      .toBe('Claude Code 2.1.282 is ready, but Claude Code agents are running. Close them to update (now 2.1.281).')
  })

  it('keeps an automatic deferral silent', () => {
    expect(describeState('claude', deferred)).toBeNull()
  })
})
