// The single source of truth for "which object keys carry a secret."
//
// WHY this is its own leaf module (extracted from unknowns.ts, 2026-07-16,
// Phase 1 of the evidence-first rendering plan): the structural fingerprint
// helper (rendering/evidence/shapeFingerprint.ts) needs this regex, and the
// unknown registry now needs the fingerprint helper — hosting the regex in
// unknowns.ts would make those two modules mutually import. A zero-import
// leaf keeps the graph acyclic while preserving the one-regex guarantee.
//
// unknowns.ts RE-EXPORTS this under its historical name so every existing
// import site — rendering/replay/redact.ts and the extraction hard gate in
// scripts/audit-sensitive-core.mts — keeps compiling unchanged and keeps
// pointing at the same object. One regex means a recording can never leak a
// key shape the unknown registry (or the fingerprint) would have hidden —
// all redaction surfaces stay in lockstep by construction.
export const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|cookie|password/i
