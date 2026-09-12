import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useAppStore } from '@renderer/app-state/hooks'
import { cwdBasename } from '@renderer/features/workspace/lib/sessionDisplay'
import {
  ROOT_MANAGEMENT_DOMAIN,
  rootManagementReloadLabels,
} from '@renderer/features/workspace/lib/rootManagement'
import { RootManagementConfirmDialog } from '@renderer/features/workspace/ui/RootManagementConfirmDialog'
import {
  reloadSessionWithBuiltInMcpDomains,
  withBuiltInMcpDomain,
} from '@renderer/workspace/builtInMcpReload'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// The surface owns only the transient prompt chrome. The grant itself is a
// domain on SessionMeta written through the same replace-session path every
// other MCP toggle uses, so autosave, rehydration and provider handoff carry
// it exactly like the rest (#906).
export function RootManagementConfirmSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.rootManagementPromptSessionId)
  const close = useAppStore(state => state.closeRootManagementPrompt)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const agentLabel = meta
    ? [meta.title, meta.kind ?? DEFAULT_PROVIDER, cwdBasename(meta.cwd)].filter(Boolean).join(' · ')
    : ''

  return (
    <RootManagementConfirmDialog
      open={sessionId !== null && meta !== null}
      agentLabel={agentLabel}
      description={meta?.cwd ?? ''}
      onCancel={close}
      onConfirm={() => {
        if (!sessionId || !meta) return
        close()
        void reloadSessionWithBuiltInMcpDomains(
          workspace,
          sessionId,
          withBuiltInMcpDomain(meta.builtInMcpDomains, ROOT_MANAGEMENT_DOMAIN, true),
          rootManagementReloadLabels(true),
        )
      }}
    />
  )
}
