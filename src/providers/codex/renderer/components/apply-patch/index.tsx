// Codex `apply_patch` component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).

import { memo, useMemo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { applyPatchText, fromCodexApplyPatch } from '@providers/codex/renderer/adapters/codeEdit'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { CodexToolRow } from '@providers/codex/renderer/components/tool'

export const CodexApplyPatchRow = memo(function CodexApplyPatchRow({
  block,
  streaming = false,
  running = false,
  result = null,
}: {
  block: ToolUseBlock
  streaming?: boolean
  running?: boolean
  result?: ToolResultBlock | null
}) {
  // CUT OVER to the code-edit protocol (PR #555 Phase 5): Codex adapter →
  // shared CodeEditView. The provider component WRAPS the shared view (the
  // plan's chrome rule) to keep two codex-specific affordances: the
  // fallback to CodexToolRow before the patch sentinel is recognizable,
  // and the "rich preview is partial" exact-paged-patch disclosure.
  const model = useMemo(
    () => fromCodexApplyPatch(block, { streaming, running, result }),
    [block, result, running, streaming],
  )
  const rawPatch = applyPatchText(block.input)
  const previewIncomplete = boundedTextPage(rawPatch).hasNext

  if (!model) {
    return <CodexToolRow block={block} />
  }

  return (
    <div className="flex flex-col gap-1">
      <CodeEditView model={model} />
      {previewIncomplete ? (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer select-none">
            Rich preview is partial · view exact paged patch
          </summary>
          <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
            <PagedTextViewer source={rawPatch} />
          </div>
        </details>
      ) : null}
    </div>
  )
})
