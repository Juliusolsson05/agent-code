import { describe, expect, it } from 'vitest'

import { dispatchRowTitle } from './rowTitle'

describe('dispatchRowTitle', () => {
  it('lets a shell row follow the live folder while an explicit title still wins (#865)', () => {
    const shell = { kind: 'terminal' as const, title: 'api', agentTitle: undefined }
    expect(dispatchRowTitle(shell, undefined, '/work/web')).toBe('web')
    expect(dispatchRowTitle(shell, undefined, null)).toBe('api')
    expect(dispatchRowTitle({ ...shell, agentTitle: 'dev server' }, undefined, '/work/web')).toBe('dev server')
  })
})
