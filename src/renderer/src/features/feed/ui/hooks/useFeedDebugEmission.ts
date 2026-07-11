import { useEffect, useRef } from 'react'

import type { StreamPhase } from '@renderer/session-runtime/state'
import type { DebugVisibleRow, VisibleDecision } from '@renderer/features/feed/types'
import { debugLabelForEntry } from '@renderer/features/feed/lib/helpers'

// PORTED VERBATIM from Feed.tsx:845-900 @269f9fc — the RENDER-layer
// feed-debug emission. This is one half of the "debug == paint"
// contract (rendering-design-principles.md P4): what lands in the
// feed-debug log is derived from the rows the painter ACTUALLY put on
// screen (DebugVisibleRow, built off the same renderItems the JSX
// maps), never a second visibility derivation that could disagree
// with the paint. Do not "optimize" this into reading the ledger
// directly — the point is that it records the paint.

export function useFeedDebugEmission({
  onDebugLog,
  entriesLength,
  visibleEntryCount,
  renderedRows,
  visibleDecisions,
  semanticTurnId,
  renderedSemanticHistoryTurnIds,
  streamPhase,
}: {
  onDebugLog?: (entry: {
    layer: 'RENDER'
    kind: string
    summary: string
    data?: unknown
  }) => void
  entriesLength: number
  visibleEntryCount: number
  renderedRows: DebugVisibleRow[]
  visibleDecisions: VisibleDecision[]
  semanticTurnId: string | null
  renderedSemanticHistoryTurnIds: string[]
  streamPhase: StreamPhase
}): void {
  const previousRenderedRowsRef = useRef<DebugVisibleRow[] | null>(null)
  const previousRenderDebugSignatureRef = useRef<string | null>(null)
  const renderedSemanticHistorySignature = renderedSemanticHistoryTurnIds.join('\u0000')

  useEffect(() => {
    if (!onDebugLog) return
    const previous = previousRenderedRowsRef.current
    const renderDebugSignature = JSON.stringify({
      entryCount: entriesLength,
      visibleEntryCount,
      itemKeys: renderedRows.map(row => row.key),
      semanticTurnId,
      semanticHistoryTurnIds: renderedSemanticHistoryTurnIds,
      streamPhase,
    })
    const prevKeys = new Set(previous?.map(row => row.key) ?? [])
    const nextKeys = new Set(renderedRows.map(row => row.key))
    const added = renderedRows.filter(row => !prevKeys.has(row.key))
    const removed = (previous ?? []).filter(row => !nextKeys.has(row.key))
    const hidden = visibleDecisions
      .filter(item => !item.visible)
      .slice(-12)
      .map(item => ({
        key: item.key,
        label: debugLabelForEntry(item.entry),
        reason: item.reason,
      }))
    const changed =
      previous === null ||
      previousRenderDebugSignatureRef.current !== renderDebugSignature ||
      added.length > 0 ||
      removed.length > 0 ||
      previous.length !== renderedRows.length ||
      previous.some((row, index) => row.key !== renderedRows[index]?.key)
    if (!changed) return
    onDebugLog({
      layer: 'RENDER',
      kind: 'visible_rows',
      summary:
        previous === null
          ? `initial rows ${renderedRows.length}`
          : `rows ${previous.length} -> ${renderedRows.length} (+${added.length} -${removed.length})`,
      data: {
        rows: renderedRows,
        added,
        removed,
        hidden,
        entryCount: entriesLength,
        visibleEntryCount,
        semanticTurnId,
        semanticHistoryTurnIds: renderedSemanticHistoryTurnIds,
        streamPhase,
      },
    })
    previousRenderedRowsRef.current = renderedRows
    previousRenderDebugSignatureRef.current = renderDebugSignature
  }, [entriesLength, onDebugLog, renderedRows, renderedSemanticHistorySignature, renderedSemanticHistoryTurnIds, semanticTurnId, streamPhase, visibleDecisions, visibleEntryCount])
}
