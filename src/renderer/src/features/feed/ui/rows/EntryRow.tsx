import { memo, useContext } from 'react'

import {
  isConversationEntry,
  type Entry,
} from '@shared/types/transcript'

import { ConversationRow } from '@renderer/features/feed/ui/rows/ConversationRow'
import { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import { useRenderShapeCapture } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'
import { GENERIC_OUTCOME, specializedOutcome } from '@renderer/features/feed/evidence/outcome'
import { ProviderContext } from '@renderer/features/feed/context'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// Memoized: entry objects are stable across store updates (we append,
// never mutate), so shallow compare by entry reference skips re-render
// for every row that didn't itself change.
//
// This is the per-entry dispatcher called by Feed's render loop. It
// picks shared transcript containers only after the active provider has had a
// chance to claim provider-authored durable artifacts such as compaction.
export const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  const capture = useRenderShapeCapture()
  const provider = useContext(ProviderContext)
  // Transcript-entry plane sighting (Phase 2, PR #555) — records which
  // ENTRY KINDS flow through the renderer and where each routed. The
  // conversation branch is deliberately NOT sighted here: its native
  // text/thinking/image leaves use provider-neutral renderers and are outside
  // the routing-shape catalog, while tool and unknown leaves are observed by
  // Block at their actual decision boundary. Sighting the container would
  // fingerprint message cardinality instead of a route and would double-count
  // every tool leaf. observationScope.ts is the executable source of truth for
  // that distinction. eventType carries the entry type plus system subtype
  // (`system:turn_duration` style) because subtype is render-relevant.
  const sight = (outcome: import('@shared/types/renderShapes').RenderOutcomeRoute): void => {
    if (!capture) return
    const subtype = (entry as { subtype?: unknown }).subtype
    observeRenderShape({
      sessionId: capture.sessionId,
      provider: capture.provider,
      plane: 'transcript-entry',
      lifecycle: 'durable',
      eventType: typeof subtype === 'string' ? `${entry.type}:${subtype}` : entry.type,
      payload: entry,
      outcome,
    })
  }
  const durable = getRendererProviderCapabilities(provider).renderDurableEntry?.({ entry })
  if (durable) {
    sight(specializedOutcome(durable.receipt.rendererId, durable.receipt.protocolId))
    return durable.node
  }
  if (isConversationEntry(entry)) {
    return <ConversationRow entry={entry} />
  }
  // SystemRow is the muted low-signal fallback for hooks/permission-mode/
  // snapshot/unknown entries — the generic outcome by definition.
  sight(GENERIC_OUTCOME)
  return <SystemRow entry={entry} />
})
