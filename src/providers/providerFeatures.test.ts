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
//
// The follow-up review found the first cut had the right idea and the wrong
// wiring: two guards were transposed (View Prompts read the switch edge list,
// Reload Agent read the shell-command flag), two commands still asked
// agent-hood, and `savedSessionListing` had no reader at all. So the matrix
// alone is not the invariant — a capability with no consumer, or a consumer
// reading someone else's capability, passes every test in this file. The
// consumers are pinned in the command-catalog tests.
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
        promptHistoryExtraction: true,
        inAppResume: true,
        switchTargets: ['codex', 'opencode'],
        verifiedExternalResumeCommand: true,
      },
      codex: {
        savedSessionListing: true,
        transcriptRewind: true,
        transcriptDuplicate: true,
        promptHistoryExtraction: true,
        inAppResume: true,
        switchTargets: ['claude', 'opencode'],
        verifiedExternalResumeCommand: true,
      },
      opencode: {
        savedSessionListing: false,
        transcriptRewind: true,
        transcriptDuplicate: true,
        promptHistoryExtraction: true,
        // The one capability OpenCode HAS. Pinned explicitly because Reload
        // Agent was hidden for it by a guard reading the unrelated
        // shell-command flag, and this row is what makes that regression
        // visible if anyone re-conflates the two.
        inAppResume: true,
        switchTargets: ['claude', 'codex'],
        verifiedExternalResumeCommand: true,
      },
    })
  })

  it('grants a terminal nothing', () => {
    // The distinction isAgentProviderKind was actually making, kept explicit.
    expect(getProviderFeatures('terminal')).toEqual({
      savedSessionListing: false,
      transcriptRewind: false,
      transcriptDuplicate: false,
      promptHistoryExtraction: false,
      inAppResume: false,
      switchTargets: [],
      verifiedExternalResumeCommand: false,
    })
  })

  it('grants an unknown or absent kind nothing', () => {
    expect(getProviderFeatures(undefined).transcriptRewind).toBe(false)
    expect(getProviderFeatures('not-a-provider').switchTargets).toEqual([])
  })

  it('grants OpenCode transcript operations without pretending it has a session index', () => {
    const opencode = getProviderFeatures('opencode')
    expect(opencode.savedSessionListing).toBe(false)
    expect(opencode.transcriptRewind).toBe(true)
    expect(opencode.transcriptDuplicate).toBe(true)
    expect(opencode.promptHistoryExtraction).toBe(true)
    expect(opencode.verifiedExternalResumeCommand).toBe(true)
    expect(opencode.switchTargets).toEqual(['claude', 'codex'])
    expect(opencode.inAppResume).toBe(true)
  })

  it('declares a complete directed switch graph for all transcript adapters', () => {
    for (const kind of AGENT_PROVIDER_KINDS) {
      expect(getProviderFeatures(kind).switchTargets)
        .toEqual(AGENT_PROVIDER_KINDS.filter(candidate => candidate !== kind))
    }
  })

  it('requires every agent provider to declare every capability', () => {
    // Adding a provider must fail here until it answers each question, rather
    // than silently inheriting broad agent powers.
    const required = [
      'savedSessionListing',
      'transcriptRewind',
      'transcriptDuplicate',
      'promptHistoryExtraction',
      'inAppResume',
      'switchTargets',
      'verifiedExternalResumeCommand',
    ]
    for (const kind of AGENT_PROVIDER_KINDS) {
      const features = getProviderFeatures(kind) as Record<string, unknown>
      for (const key of required) expect(features[key]).toBeDefined()
    }
  })
})
