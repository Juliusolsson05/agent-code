import { describe, expect, it } from 'vitest'

import {
  systemTestIncludes,
  unitTestIncludes,
  unitTierExcludes,
} from '../../vitest.config'

describe('root test-tier routing', () => {
  it('keeps private submodule suites out of the Agent Code runner', () => {
    // WHY this asserts the positive allowlist rather than one package-specific
    // exclusion: a new submodule must be safe by default. Reintroducing a
    // packages/**/*.test.ts sweep would make its live and process tests inherit
    // Agent Code's environment and parallelism before anyone reviewed them.
    expect(unitTestIncludes).toEqual([
      'testing/unit/**/*.test.ts',
      'src/**/*.test.ts',
    ])
  })

  it('quarantines every specialized suffix from the core project', () => {
    expect(unitTierExcludes).toEqual(expect.arrayContaining([
      '**/*.system.test.ts',
      '**/*.live.test.ts',
      '**/*.soak.test.ts',
      '**/*.corpus.test.ts',
      '**/*.integration.test.ts',
      '**/*.renderer.test.ts',
    ]))
  })

  it('routes shared and legacy cross-boundary suffixes into the system project', () => {
    expect(systemTestIncludes).toEqual(expect.arrayContaining([
      'src/**/*.system.test.ts',
      'src/**/*.integration.test.ts',
    ]))
  })
})
