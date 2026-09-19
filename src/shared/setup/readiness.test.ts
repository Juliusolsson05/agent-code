import { describe, expect, it } from 'vitest'

import { deriveReadiness } from '@shared/setup/readiness.js'
import {
  loadFirstRunBaseline,
  loadFirstRunCheck,
  withoutMachineWideInstalls,
} from '@shared/setup/firstRunRecordings.testSupport.js'

// The readiness policy (#995) over the RECORDED first-run probes
// (testing/fixtures/first-run). Every input here is what the real
// checkPrerequisites reported on a simulated clean Mac, the packaged app on
// it, and a developer machine; see that folder's README.

describe('first-run readiness over recorded machines (#995)', () => {
  it('the packaged app on a clean Mac opens its first project with the bundled OpenCode', () => {
    const check = loadFirstRunCheck('clean-machine-packaged')
    expect(check.tools.opencode).toMatchObject({ found: true, source: 'bundled' })
    expect(deriveReadiness(check.tools).firstSessionKind).toBe('opencode')
  })

  it('a Mac whose only provider is Grok opens with Grok', () => {
    // The recording machine's npm-global Grok is outside the simulated HOME,
    // so the clean recording is a real "Grok only" machine.
    expect(deriveReadiness(loadFirstRunCheck('clean-machine').tools)).toEqual({ usableProviders: ['grok'], firstSessionKind: 'grok' })
  })

  it('a Mac with no provider at all opens a terminal, never a lockout', () => {
    const check = withoutMachineWideInstalls(loadFirstRunCheck('clean-machine'))
    expect(check.usableProviders).toEqual([])
    expect(check.firstSessionKind).toBe('terminal')
  })

  it('a machine with the default provider behaves exactly as before: Claude first', () => {
    expect(deriveReadiness(loadFirstRunCheck('developer-machine').tools).firstSessionKind).toBe('claude')
  })

  it('every machine the old gate locked out had something to run', () => {
    // The baseline is the pre-#995 verdict on the same recordings. Both clean
    // machines were `ready: false`, blocked on Claude and Codex, while a
    // provider was usable. That is the wall this policy removes.
    const baseline = loadFirstRunBaseline()
    for (const environment of ['clean-machine', 'clean-machine-packaged'] as const) {
      expect(baseline[environment].verdict).toEqual({ ready: false, blocking: ['claude', 'codex'] })
      expect(deriveReadiness(loadFirstRunCheck(environment).tools).usableProviders.length).toBeGreaterThan(0)
    }
  })

  it('what main recorded is what the policy derives, so no consumer can disagree with it', () => {
    for (const environment of ['clean-machine', 'clean-machine-packaged', 'developer-machine'] as const) {
      const check = loadFirstRunCheck(environment)
      expect(deriveReadiness(check.tools)).toEqual({ usableProviders: check.usableProviders, firstSessionKind: check.firstSessionKind })
    }
  })
})
