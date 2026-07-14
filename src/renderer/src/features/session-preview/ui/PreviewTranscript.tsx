import { memo, useMemo } from 'react'

import type { AgentProvider } from '@renderer/features/feed/types'
import {
  CodeRenderContext,
  ToolResultIndexContext,
} from '@renderer/features/feed/context'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'
import { PresentationRow } from '@renderer/features/feed/ui/operations/PresentationRow'

import type { PreviewModel } from '@renderer/features/session-preview/previewModel'

// PreviewTranscript — renders a transcript tail through the REAL feed
// presentation projection, not a bespoke or legacy block dispatcher.
//
// WHY project the static entries into FeedRenderItems here: the live Feed gets
// those items from the ownership ledger, but a preview is already a filtered,
// immutable transcript tail and owns no SessionRuntime. Synthesizing only the
// ledger's frozen entry-shaped contract lets both surfaces share the exact
// post-clean-event projector and OperationRow without mounting live machinery.
//
// WHY this still isn't "just mount <Feed>":
//   <Feed> carries live-session machinery a static preview must not
//   inherit — scroll-position persistence keyed by sessionId (would
//   fight the real feed's scroll state for the same session), lazy
//   m/unmount, the semantic live turn, work indicators, older-history
//   pagination. We want the projected ROWS, not the shell. So we render them
//   directly and supply the result and code contexts used by durable subagent
//   status and code rendering. Provider identity and tool pairing are already
//   structural fields on the projection.
//
// Performance note: CodeBlock defaults to `engine: 'static'`
// (highlight.js), NOT Monaco — so a code-heavy preview re-rendering on
// hover stays cheap. TextProse memoizes markdown parsing by text
// string, so re-hovering a session already seen is close to free.

export const PreviewTranscript = memo(function PreviewTranscript({
  model,
  provider,
  sessionId,
  workspaceRoot,
}: {
  model: PreviewModel
  provider: AgentProvider
  // Feeds CodeRenderContext: CodeBlock mints stable codeIds from the
  // sessionId and wires LSP/file links against the workspace root.
  sessionId: string
  workspaceRoot: string | null
}) {
  const presentation = useMemo(() => {
    const items: FeedRenderItem[] = model.entries.map((entry, index) => ({
      type: 'entry',
      key: `preview:${typeof entry.uuid === 'string' ? entry.uuid : index}`,
      entry,
      entryOrdinal: index,
      visibleDecision: {
        key: `preview:${typeof entry.uuid === 'string' ? entry.uuid : index}`,
        entry,
        visible: true,
        reason: 'conversation',
      },
      order: {
        phase: 'content',
        timeMs: typeof entry.timestamp === 'string'
          ? Date.parse(entry.timestamp)
          : null,
        sequence: index,
        source: 'session-preview',
      },
    }))
    return projectFeedPresentation({
      items,
      provider,
      toolUseIndex: model.toolUseIndex,
      toolResultIndex: model.toolResultIndex,
    })
  }, [model.entries, model.toolResultIndex, model.toolUseIndex, provider])

  return (
    <ToolResultIndexContext.Provider value={model.toolResultIndex}>
      <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
        {/* `px-8` is load-bearing, not cosmetic: UserBand pulls
            itself edge-to-edge with `-mx-8 px-8`, assuming an
            8-unit gutter. Match it here or user prompt bands
            overflow. Mirrors the feed column's own `px-8`
            (Feed.tsx). */}
        <div className="px-8 py-5 flex flex-col gap-4">
          {presentation.nodes.map(node => (
            <div key={node.id}>
              <PresentationRow
                node={node}
                turnStartedAt={null}
                toolHint={null}
              />
            </div>
          ))}
        </div>
      </CodeRenderContext.Provider>
    </ToolResultIndexContext.Provider>
  )
})
