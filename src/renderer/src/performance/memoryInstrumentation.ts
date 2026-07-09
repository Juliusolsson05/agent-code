import type { SessionRuntime } from '@renderer/session-runtime/state'
import { trimmedUuidCount } from '@renderer/session-runtime/liveEntryWindow'
import { codeBlockRegistrySize } from '@renderer/features/copy-code-block/lib/codeBlockRegistry'
import { monacoModelCount } from '@renderer/lib/code/monacoModelProbe'

import * as perf from './client'

// -----------------------------------------------------------------------------
// Renderer memory instrumentation (#375 part A).
//
// The existing `renderer.memory.usedJSHeapSize` gauge (client.ts) tells us the
// heap is growing but not WHICH per-session structure is responsible. This
// module emits per-session size/byte gauges for every structure the #375
// investigation identified as unbounded or windowed:
//
//   entries array (the live window), semantic history/log ring buffers,
//   feed-debug ring, ghost map, tool_use/tool_result indices, seen-uuid set,
//   trimmed-uuid set — plus the two renderer-global registries (code-block
//   source registry, Monaco model count).
//
// Emitted from a slow 30s timer in useIpcSubscriptions (piggybacking on the
// same effect as the 1 Hz ghost sweep, but on its own interval — the sweep
// cadence is a correctness knob, the gauge cadence is a cost knob, and tying
// them would make someone tune one and silently change the other).
//
// Nothing here is gated on the perf flag BEYOND what perf.gauge already does
// (enqueue no-ops when telemetry is off): the sampling below is O(sessions ×
// SAMPLE_CAP stringifys) every 30s, which is noise even with telemetry on.
// -----------------------------------------------------------------------------

/** Cap on how many items a byte estimate stringifies per collection.
 *
 *  WHY sampling instead of accumulating exact byte counts at ingest or
 *  stringifying whole collections here: ingest-time accounting would put
 *  a JSON.stringify of every entry on the HOT append path and would need
 *  decrement bookkeeping on every trim/reload/reconcile site to stay
 *  honest (a whole class of drift bugs for a diagnostic number). Full
 *  stringify on the timer is O(total bytes) per tick — exactly the
 *  workload we're instrumenting against. A 30s gauge only needs
 *  order-of-magnitude trend fidelity ("entries plateaued after the trim
 *  landed", "semantic.log is 40 MB, entries are 2 MB"), so we stringify
 *  up to SAMPLE_CAP evenly-spaced items and extrapolate avg × length. */
const SAMPLE_CAP = 64

export function estimateJsonBytesSampled(items: readonly unknown[]): number {
  if (items.length === 0) return 0
  const step = Math.max(1, Math.floor(items.length / SAMPLE_CAP))
  let sampled = 0
  let sampledBytes = 0
  for (let i = 0; i < items.length; i += step) {
    sampled += 1
    try {
      // string.length undercounts multi-byte UTF-8 but is allocation-free
      // compared to TextEncoder; for a trend gauge the constant factor is
      // irrelevant.
      sampledBytes += JSON.stringify(items[i])?.length ?? 0
    } catch {
      // Circular or otherwise unstringifiable item — shouldn't exist in
      // these collections, but a diagnostic must never throw into ingest.
    }
  }
  if (sampled === 0) return 0
  return Math.round((sampledBytes / sampled) * items.length)
}

/**
 * Emit one round of memory gauges. `runtimes`/`seenUuids` come from the
 * workspace ref mirrors (refs.latestRuntimesRef / refs.seenUuidsRef), so the
 * sweep reads live values without subscribing to React state.
 */
export function emitRendererMemoryGauges(
  runtimes: Record<string, SessionRuntime>,
  seenUuids: Record<string, Set<string>>,
): void {
  for (const [sessionId, runtime] of Object.entries(runtimes)) {
    // Terminal panes and empty placeholders: skip entirely rather than emit
    // rows of zeros — keeps the journal grep-able and the sweep O(active
    // sessions) in the common many-terminal-panes workspace.
    if (
      runtime.entries.length === 0 &&
      runtime.semantic.log.length === 0 &&
      runtime.feedDebugLog.length === 0
    ) {
      continue
    }
    perf.gauge('renderer.session.memory.entries', runtime.entries.length, {
      sessionId,
      bytesEstimate: estimateJsonBytesSampled(runtime.entries),
      totalEntries: runtime.totalEntries,
    })
    perf.gauge(
      'renderer.session.memory.semanticHistoryBytes',
      estimateJsonBytesSampled(runtime.semantic.history),
      { sessionId, turns: runtime.semantic.history.length },
    )
    perf.gauge(
      'renderer.session.memory.semanticLogBytes',
      estimateJsonBytesSampled(runtime.semantic.log),
      { sessionId, logLength: runtime.semantic.log.length },
    )
    perf.gauge('renderer.session.memory.feedDebugLog', runtime.feedDebugLog.length, {
      sessionId,
    })
    perf.gauge('renderer.session.memory.ghostMap', runtime.ghosts.size, { sessionId })
    perf.gauge('renderer.session.memory.toolIndex', runtime.toolUseIndex.size, {
      sessionId,
      toolResultIndexSize: runtime.toolResultIndex.size,
    })
    perf.gauge(
      'renderer.session.memory.seenUuids',
      seenUuids[sessionId]?.size ?? 0,
      { sessionId, trimmedUuids: trimmedUuidCount(sessionId) },
    )
  }

  perf.gauge('renderer.global.memory.codeBlockRegistry', codeBlockRegistrySize())

  // Monaco models leak when editors are disposed without their models. The
  // probe is null until Monaco's lazy chunk has ACTUALLY loaded (it is
  // registered from inside getMonaco — see monacoModelProbe.ts), so this can
  // never be the thing that forces the multi-MB Monaco load.
  const models = monacoModelCount()
  if (models !== null) {
    perf.gauge('renderer.global.memory.monacoModels', models)
  }
}
