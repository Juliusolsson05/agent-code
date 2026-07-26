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
        switchTargets: ['codex'],
        verifiedExternalResumeCommand: true,
      },
      codex: {
        savedSessionListing: true,
        transcriptRewind: true,
        transcriptDuplicate: true,
        promptHistoryExtraction: true,
        inAppResume: true,
        switchTargets: ['claude'],
        verifiedExternalResumeCommand: true,
      },
      opencode: {
        savedSessionListing: false,
        transcriptRewind: false,
        transcriptDuplicate: false,
        promptHistoryExtraction: false,
        // The one capability OpenCode HAS. Pinned explicitly because Reload
        // Agent was hidden for it by a guard reading the unrelated
        // shell-command flag, and this row is what makes that regression
        // visible if anyone re-conflates the two.
        inAppResume: true,
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

  it('leaves OpenCode unavailable for every unsupported operation', () => {
    // Named individually rather than as a group: each flips when its OWN
    // adapter becomes real, and flipping them together is the mistake this
    // whole phase exists to prevent.
    const opencode = getProviderFeatures('opencode')
    expect(opencode.savedSessionListing).toBe(false)
    expect(opencode.transcriptRewind).toBe(false)
    expect(opencode.transcriptDuplicate).toBe(false)
    expect(opencode.promptHistoryExtraction).toBe(false)
    expect(opencode.verifiedExternalResumeCommand).toBe(false)
    expect(opencode.switchTargets).toEqual([])
    // NOT in the list above: in-app resume genuinely works for OpenCode.
    // Grouping it with the rest is the exact mistake that hid Reload Agent.
    expect(opencode.inAppResume).toBe(true)
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
