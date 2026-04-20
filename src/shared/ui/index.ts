export { MarkerRow } from './MarkerRow'
export { LazyEntry, EAGER_TAIL } from './LazyEntry'
export { UserBand } from './UserBand'
// `ActivityIndicator` removed 2026-04-18 — replaced in-feed by
// `src/renderer/src/feed/WorkIndicator.tsx`, driven by
// `runtime.streamPhase`. The old export was never imported anywhere
// (the Feed had its own local duplicate); this comment stands in so
// future archaeologists see the rename instead of wondering why
// `ActivityIndicator` vanished.
