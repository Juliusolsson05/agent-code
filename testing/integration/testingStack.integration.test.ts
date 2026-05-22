import { describe, expect, it } from 'vitest'

import { debugBundleRootForReason } from '@main/storage/debugBundleLog'

describe('integration test project', () => {
  it('has a separate project for multi-module Node tests', () => {
    expect(new URL('file:///tmp/agent-code').protocol).toBe('file:')
  })

  it('resolves main-process aliases in integration tests', () => {
    expect(debugBundleRootForReason('manual')).toContain('debug-bundles')
  })
})
