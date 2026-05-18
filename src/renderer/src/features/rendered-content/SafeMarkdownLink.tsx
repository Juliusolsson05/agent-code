import { useCallback, useContext, type MouseEvent, type ReactNode } from 'react'

import { classifyRenderedTarget } from '@shared/renderedContent/targets'

import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'

type Props = {
  href?: string
  children?: ReactNode
  title?: string
  className?: string
}

export function SafeMarkdownLink({
  href,
  children,
  title,
  className,
}: Props) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const { showToast } = useGlobalToast()
  const target = classifyRenderedTarget(href, { workspaceRoot })

  const activate = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      event.stopPropagation()

      if (target.kind === 'external-url') {
        try {
          const result = await window.api.openRenderedExternalUrl({ url: target.url })
          if (!result.ok) showToast('Blocked unsupported link')
        } catch {
          showToast('Could not open link')
        }
        return
      }

      if (target.kind === 'local-file') {
        if (!workspaceRoot) {
          showToast('No workspace for file link')
          return
        }
        const result = await openFileInGlobalEditor({
          root: workspaceRoot,
          path: target.path,
          line: target.line,
          column: target.column,
        })
        if (!result.ok) showToast(`Could not open file: ${result.error}`)
        return
      }

      showToast('Blocked unsupported link')
    },
    [showToast, target, workspaceRoot],
  )

  if (target.kind === 'unsupported') {
    return (
      <span
        className={className}
        title={title ?? 'Unsupported link blocked'}
      >
        {children}
      </span>
    )
  }

  // WHY this still renders an <a> while never trusting native navigation:
  // rendered markdown comes from agents/providers, not from app-authored UI.
  // We keep the semantic affordance and copyable href for real links, but the
  // click path always preventDefaults into classifyRenderedTarget. That gives
  // one deliberate policy for http(s), workspace files, and blocked protocols,
  // while the main-process will-navigate guard remains the final backstop.
  return (
    <a
      href={target.kind === 'external-url' ? target.url : '#'}
      className={className}
      title={title}
      onClick={activate}
      onAuxClick={activate}
    >
      {children}
    </a>
  )
}
