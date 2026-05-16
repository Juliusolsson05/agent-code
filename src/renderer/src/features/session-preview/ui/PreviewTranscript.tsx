import { memo } from 'react'

import type { Entry } from '@shared/types/transcript'
import type { AgentProvider } from '@renderer/features/feed/types'
import {
  CodeRenderContext,
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { EntryRow } from '@renderer/features/feed/ui/rows'

import type { PreviewModel } from '@renderer/features/session-preview/previewModel'

// PreviewTranscript — renders a transcript tail using the REAL feed row
// components, not a bespoke renderer.
//
// WHY reuse `EntryRow` instead of a hand-rolled renderer:
//   `EntryRow` → `ConversationRow` → `Block` already does markdown
//   (TextProse), syntax-highlighted code (CodeBlock), user-prompt
//   highlight bands (UserBand), and every provider-specific tool row.
//   The earlier hand-rolled plain-text renderer reimplemented a
//   fraction of that, badly. Rendering the same rows the feed renders
//   means the preview is faithful for free and stays in sync as the
//   feed evolves.
//
// WHY this still isn't "just mount <Feed>":
//   <Feed> carries live-session machinery a static preview must not
//   inherit — scroll-position persistence keyed by sessionId (would
//   fight the real feed's scroll state for the same session), lazy
//   m/unmount, the semantic live turn, work indicators, older-history
//   pagination. We want the ROWS, not the shell. So we render the rows
//   directly and supply, by hand, the four React contexts `Feed` would
//   otherwise provide (see src/renderer/src/features/feed/context.tsx):
//   provider, the two tool-pairing index maps, and the code-render
//   context. Those four are the entire contract between Feed and its
//   rows — supply them and the rows behave exactly as in the feed.
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
  return (
    <ProviderContext.Provider value={provider}>
      <ToolUseIndexContext.Provider value={model.toolUseIndex}>
        <ToolResultIndexContext.Provider value={model.toolResultIndex}>
          <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
            {/* `px-8` is load-bearing, not cosmetic: UserBand / ToolBand
                pull themselves edge-to-edge with `-mx-8 px-8`, assuming
                an 8-unit gutter. Match it here or the bands overflow.
                Mirrors the feed column's own `px-8` (Feed.tsx). */}
            <div className="px-8 py-5 flex flex-col gap-4">
              {model.entries.map((entry, i) => {
                const uuid = (entry as { uuid?: string }).uuid
                return (
                  <div key={uuid ?? `i${i}`}>
                    <EntryRow entry={entry} />
                  </div>
                )
              })}
            </div>
          </CodeRenderContext.Provider>
        </ToolResultIndexContext.Provider>
      </ToolUseIndexContext.Provider>
    </ProviderContext.Provider>
  )
})
