import { useCallback, useContext, type MouseEvent, type ReactNode } from 'react'

import { classifyRenderedTarget } from '@shared/renderedContent/targets'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

export function SafeInlineCode({ children }: { children?: ReactNode }) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const { showToast } = useGlobalToast()
  const text = String(children ?? '')
  const target = classifyRenderedTarget(text, { workspaceRoot })

  const activate = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (target.kind !== 'local-file' || !workspaceRoot) return
      const result = await openFileInGlobalEditor({
        root: workspaceRoot,
        path: target.path,
        line: target.line,
        column: target.column,
      })
      if (!result.ok) showToast(`Could not open file: ${result.error}`)
    },
    [showToast, target, workspaceRoot],
  )

  if (target.kind !== 'local-file') return <code>{children}</code>

  // WHY inline code gets only local-file activation, not generic link
  // activation: agents often wrap paths in backticks, and those are useful
  // editor affordances. But inline code also contains commands, flags,
  // identifiers, and untrusted snippets. Restricting this path to conservative
  // workspace-file candidates avoids turning arbitrary prose or shell syntax
  // into clickable navigation while still covering the common `src/file.ts:42`
  // feed workflow from issue #181.
  return (
    <code>
      <button
        type="button"
        className="font-code text-accent underline decoration-accent/40 underline-offset-2"
        title="Open in Global Editor"
        onClick={activate}
      >
        {children}
      </button>
    </code>
  )
}
