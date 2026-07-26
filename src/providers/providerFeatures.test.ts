import { describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'

// ---------------------------------------------------------------------------
// Phase 5: provider capability policy.
//
// The audit's high-severity finding was that `isAgentProviderKind()` was being
// consumed as a FEATURE capability. It only distinguishes agents from
// terminals. Because every agent provider passed it, OpenCode received Resume,
// Rewind, Duplicate, Switch Provider and Copy Resume — all empty, rejected,
// unsupported or unverified for it. This file pins the matrix so a provider
// cannot inherit a feature by joining AGENT_PROVIDER_KINDS.
// ---------------------------------------------------------------------------

describe('provider feature matrix', () => {
  it('matches the plan table exactly', () => {
    const matrix = Object.fromEntries(
      AGENT_PROVIDER_KINDS.map(kind => [kind, getProviderFeatures(kind)]),
    )
    expect(matrix).toEqual({
      claude: {
        savedSessionListing: true,
        transcriptRewind: true,
        transcriptDuplicate: true,
        switchTargets: ['codex'],
        verifiedExternalResumeCommand: true,
      },
      codex: {
        savedSessionListing: true,
        transcriptRewind: true,
        transcriptDuplicate: true,
        switchTargets: ['claude'],
        verifiedExternalResumeCommand: true,
      },
      opencode: {
        savedSessionListing: false,
        transcriptRewind: false,
        transcriptDuplicate: false,
        switchTargets: [],
        verifiedExternalResumeCommand: false,
      },
    })
  })

  it('grants a terminal nothing', () => {
    // The distinction isAgentProviderKind was actually making, kept explicit.
    expect(getProviderFeatures('terminal')).toEqual({
      savedSessionListing: false,
      transcriptRewind: false,
      transcriptDuplicate: false,
      switchTargets: [],
      verifiedExternalResumeCommand: false,
    })
  })

  it('grants an unknown or absent kind nothing', () => {
    expect(getProviderFeatures(undefined).transcriptRewind).toBe(false)
    expect(getProviderFeatures('not-a-provider').switchTargets).toEqual([])
  })

  it('leaves OpenCode unavailable for every unsupported operation', () => {
    // Named individually rather than as a group: each flips when its OWN
    // adapter becomes real, and flipping them together is the mistake this
    // whole phase exists to prevent.
    const opencode = getProviderFeatures('opencode')
    expect(opencode.savedSessionListing).toBe(false)
    expect(opencode.transcriptRewind).toBe(false)
    expect(opencode.transcriptDuplicate).toBe(false)
    expect(opencode.verifiedExternalResumeCommand).toBe(false)
    expect(opencode.switchTargets).toEqual([])
  })

  it('keeps switch edges directional and symmetric only where declared', () => {
    // Claude<->Codex is a real round trip; nothing points at OpenCode, and
    // OpenCode points at nothing. A boolean "canSwitch" could not express that.
    expect(getProviderFeatures('claude').switchTargets).toEqual(['codex'])
    expect(getProviderFeatures('codex').switchTargets).toEqual(['claude'])
    for (const kind of AGENT_PROVIDER_KINDS) {
      expect(getProviderFeatures(kind).switchTargets).not.toContain('opencode')
    }
  })

  it('requires every agent provider to declare all five capabilities', () => {
    // Adding a provider must fail here until it answers each question, rather
    // than silently inheriting broad agent powers.
    const required = [
      'savedSessionListing',
      'transcriptRewind',
      'transcriptDuplicate',
      'switchTargets',
      'verifiedExternalResumeCommand',
    ]
    for (const kind of AGENT_PROVIDER_KINDS) {
      const features = getProviderFeatures(kind) as Record<string, unknown>
      for (const key of required) expect(features[key]).toBeDefined()
    }
  })
})
