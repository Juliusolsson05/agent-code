import { describe, expect, it } from 'vitest'

import { normalizeAllowedExternalUrl } from '@shared/renderedContent/targets'

describe('unit test project', () => {
  it('runs pure TypeScript tests through Vitest', () => {
    expect(1 + 1).toBe(2)
  })

  it('resolves project aliases in unit tests', () => {
    expect(normalizeAllowedExternalUrl('https://example.com')).toBe('https://example.com/')
  })

  it('forces NODE_ENV=test for React and other test-sensitive libraries', () => {
    expect(process.env.NODE_ENV).toBe('test')
  })
})
