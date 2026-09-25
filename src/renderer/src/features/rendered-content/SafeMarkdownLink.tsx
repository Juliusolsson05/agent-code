import { useCallback, useContext } from 'react'
import type { MouseEvent, ReactNode } from 'react'

import { classifyRenderedTarget } from '@shared/renderedContent/targets'

import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { useRendererHost } from '@renderer/features/rendererHost/RendererHostContext'

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
  const { workspaceRoot, sessionId } = useContext(CodeRenderContext)
  const { showToast } = useGlobalToast()
  // WHERE a link opens is the host's decision (#1177): the desktop routes a
  // loopback link to the session's browser pocket or asks main to open it,
  // the phone opens a new tab, a host with no editor cannot open files at
  // all. The CLASSIFICATION below stays here, shared, because which targets
  // are safe to activate is one policy for every host.
  const { openExternalUrl, openWorkspaceFile } = useRendererHost()
  const target = classifyRenderedTarget(href, { workspaceRoot })

  const activate = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      event.stopPropagation()

      if (target.kind === 'external-url') {
        const outcome = await openExternalUrl({
          url: target.url,
          sessionId,
          modifierHeld: event.metaKey || event.ctrlKey,
        })
        if (outcome === 'blocked') showToast('Blocked unsupported link')
        else if (outcome === 'failed') showToast('Could not open link')
        return
      }

      if (target.kind === 'local-file') {
        if (!workspaceRoot) {
          showToast('No workspace for file link')
          return
        }
        if (!openWorkspaceFile) return
        const result = await openWorkspaceFile({
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
    [openExternalUrl, openWorkspaceFile, sessionId, showToast, target, workspaceRoot],
  )

  // A host with no editor renders a file link as its text: an anchor there
  // would be a control that can only fail.
  if (target.kind === 'local-file' && !openWorkspaceFile) {
    return <span className={className} title={title}>{children}</span>
  }

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
