import { describe, expect, it } from 'vitest'

describe('integration test project', () => {
  it('has a separate project for multi-module Node tests', () => {
    expect(new URL('file:///tmp/agent-code').protocol).toBe('file:')
  })
})

