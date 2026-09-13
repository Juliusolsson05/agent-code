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
      'src/**/*.test.tsx',
    ])
  })

  it('collects .tsx so a test cannot fall between every project', () => {
    // The renderer project takes only `*.renderer.test.tsx`, so before `.tsx` was
    // added above, a file named `Foo.test.tsx` matched NO project: it ran nowhere,
    // vitest reported success, and the contract script — which greps for `.only`,
    // not for project membership — agreed. A test that silently never runs is worse
    // than a missing one, because the coverage it appears to provide is counted.
    expect(unitTestIncludes).toContain('src/**/*.test.tsx')
  })

  it('quarantines every specialized suffix from the core project, in BOTH extensions', () => {
    // The `.tsx` half is load-bearing rather than symmetric-for-neatness: the unit
    // include now covers `src/**/*.test.tsx`, which `*.renderer.test.tsx` also
    // matches. Without these excludes every renderer test is ALSO collected into the
    // node-environment unit project and fails with "document is not defined".
    expect(unitTierExcludes).toEqual(expect.arrayContaining([
      '**/*.system.test.ts',
      '**/*.system.test.tsx',
      '**/*.live.test.ts',
      '**/*.live.test.tsx',
      '**/*.soak.test.ts',
      '**/*.soak.test.tsx',
      '**/*.corpus.test.ts',
      '**/*.corpus.test.tsx',
      '**/*.integration.test.ts',
      '**/*.renderer.test.ts',
      '**/*.renderer.test.tsx',
    ]))
  })

  it('routes shared and legacy cross-boundary suffixes into the system project', () => {
    expect(systemTestIncludes).toEqual(expect.arrayContaining([
      'src/**/*.system.test.ts',
      'src/**/*.integration.test.ts',
    ]))
  })
})
