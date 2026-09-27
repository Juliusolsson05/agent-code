import type { NativeResumeProjectionResult } from 'agent-transcript-parser'

// A native-resume projection with an EMPTY report, for host tests whose
// subject is not fidelity (identity, cwd, profile, write order).
//
// WHY a helper and not `{ values }`: since #927 every operation summarizes
// `projection.report`, and a projection without one is a shape no real
// projector returns. Tests that DO assert fidelity must not use this: they run
// the real projector over a recorded sequence (projectionFidelity.system.test).
export function losslessProjection(
  values: Record<string, unknown>[],
  provider = 'codex',
): NativeResumeProjectionResult {
  return {
    profile: 'native-resume',
    targetProvider: provider,
    providerProfile: { id: 'test', provider, evidence: {} },
    values,
    report: {
      profile: 'native-resume',
      sourceProvider: provider,
      targetProvider: provider,
      changes: [],
      counts: { preserved: 0, dropped: 0, demoted: 0, synthesized: 0, repaired: 0, retargeted: 0, opaque: 0 },
    },
  }
}
