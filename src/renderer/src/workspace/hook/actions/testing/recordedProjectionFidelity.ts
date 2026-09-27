import type { NativeProjectionFidelity } from '@shared/types/projectionFidelity'

// Renderer tests cannot run the parser's projectors, so these are the REAL
// summaries, copied from `summarizeProjectionReport` over the recorded Stage 0
// sequences (projected to Codex 0.157.1 as projectionFidelity.system.test.ts
// does) (#927). Only `sourceLines` is trimmed to two per row. Counts, codes,
// profile and evidence are exactly as produced.

/** claude-sequence-oversized -> Codex: nothing shrunk, 19 entries demoted. */
export const DEMOTING_SWITCH_FIDELITY: NativeProjectionFidelity = {
  profile: 'native-resume',
  sourceProvider: 'claude',
  targetProvider: 'codex',
  providerProfileId: 'codex-rollout-source-8035cb03',
  providerEvidence: { sourceCommit: '8035cb03f1a5061d0342cb8fa3a10a18068ca683' },
  counts: { preserved: 67, dropped: 0, demoted: 19, synthesized: 2, repaired: 0, retargeted: 0, opaque: 0 },
  codes: [
    { kind: 'synthesized', code: 'native-resume.session-meta.synthesized', count: 1, sourceLines: [] },
    { kind: 'synthesized', code: 'native-resume.turn-framing.synthesized', count: 1, sourceLines: [] },
    { kind: 'preserved', code: 'native-resume.message.preserved', count: 6, sourceLines: [0, 14] },
    { kind: 'preserved', code: 'native-resume.reasoning.preserved', count: 9, sourceLines: [1, 8] },
    { kind: 'demoted', code: 'native-resume.reasoning.encrypted-content-demoted', count: 9, sourceLines: [1, 8] },
    { kind: 'preserved', code: 'native-resume.tool-call.preserved', count: 26, sourceLines: [2, 4] },
    { kind: 'preserved', code: 'native-resume.tool-result.preserved', count: 26, sourceLines: [3, 6] },
    { kind: 'demoted', code: 'native-resume.tool-result.error-status-demoted', count: 10, sourceLines: [3, 6] },
  ],
  sourceLinesOmitted: 12,
}

/** codex-sequence-compaction -> Codex (a duplicate): only an opaque record
 *  dropped, which is not material. */
export const OPAQUE_ONLY_DUPLICATE_FIDELITY: NativeProjectionFidelity = {
  profile: 'native-resume',
  sourceProvider: 'codex',
  targetProvider: 'codex',
  providerProfileId: 'codex-rollout-source-8035cb03',
  providerEvidence: { sourceCommit: '8035cb03f1a5061d0342cb8fa3a10a18068ca683' },
  counts: { preserved: 1, dropped: 1, demoted: 0, synthesized: 1, repaired: 0, retargeted: 0, opaque: 0 },
  codes: [
    { kind: 'synthesized', code: 'native-resume.session-meta.synthesized', count: 1, sourceLines: [] },
    { kind: 'dropped', code: 'native-resume.opaque.dropped', count: 1, sourceLines: [0] },
    { kind: 'preserved', code: 'native-resume.compaction.preserved', count: 1, sourceLines: [1] },
  ],
  sourceLinesOmitted: 0,
}
