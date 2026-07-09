// Raw semantic-event capture flag (#375 part C).
//
// The semantic reducer's debug log (`semantic.log`) and the feed-debug SEM
// entries used to retain the ENTIRE raw semantic event per row. Those events
// carry full text/tool payload deltas; at SEMANTIC_LOG_CAP=200 ×
// FEED_DEBUG_LOG_CAP=500 × sessions, that's a large slab of heap whose only
// consumers are the dev-debug panels and exported debug bundles. Default is
// now a compact summary; the raw payload is captured only when this flag is
// on.
//
// WHY a module-level flag instead of threading config through the reducer:
// foldSemanticEvent is a pure synchronous reducer with no config parameter,
// called from hot ingest paths; the flag is process-wide diagnostic state,
// not per-session state. This mirrors how the perf client holds its own
// module-level `config` set once at startup.
//
// WHY it rides AGENT_CODE_DEV_DEBUG (the existing dev-debug precedent, see
// main/ipc/devDebug.ts) instead of a new env var: raw semantic payloads are
// only readable through the dev-debug surfaces (DevDebugPanel modules,
// debug bundles), so the capture flag and the surface that displays it
// should be the same switch — a separate flag would just create the
// "capture on, panel off" and "panel on, log empty" confusion quadrants.
// App.tsx already probes `getDevDebugConfig()` on boot and calls
// setSemanticRawCaptureEnabled with the result.
//
// Default false: production sessions get summaries. The probe resolves
// within the first ticks of app boot, so at worst the first handful of
// events in a dev-debug run miss raw capture — acceptable for a
// diagnostic-only surface.

let rawCaptureEnabled = false

export function setSemanticRawCaptureEnabled(enabled: boolean): void {
  rawCaptureEnabled = enabled
}

export function isSemanticRawCaptureEnabled(): boolean {
  return rawCaptureEnabled
}
