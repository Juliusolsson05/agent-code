import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { DebugPanel } from '@renderer/features/debug/ui/DebugPanel'
import { FeedDebugPanel } from '@renderer/features/debug/ui/FeedDebugPanel'
import { ProxyDebugPanel } from '@renderer/features/debug/ui/ProxyDebugPanel'
import { HtmlDebugPanel } from '@renderer/features/debug/ui/HtmlDebugPanel'
import { DevDebugPanel } from '@renderer/features/debug/ui/DevDebugPanel'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { useDevDebugConfig } from '@renderer/features/debug/devDebugConfig'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { getEffectiveAgentSurface } from '@renderer/workspace/agentDisplayMode'

// The five debug side panels, one block per panel-flag, in the exact
// order App.tsx mounted them. All five need the command-target session;
// each also carries its original guard (e.g. DevDebugPanel additionally
// requires the dev-debug config — that gate predates #494 and moves
// here untouched).
export function DebugSurfacesImpl() {
  const workspace = useWorkspaceContext()
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const devDebugPanelOpen = useAppStore(state => state.devDebugPanelOpen)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const devDebugEnabled = useDevDebugConfig(state => state.enabled)

  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  const kind = workspace.state.sessions[targetId]?.kind ?? DEFAULT_PROVIDER

  return (
    <>
      {debugPanelOpen && (
        <DebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          inlineRawTerminalDisabled={
            getEffectiveAgentSurface({
              kind,
              mode: agentViewMode,
              runtime: workspace.getRuntime(targetId),
            }) === 'terminal'
          }
          onClose={toggleDebugPanel}
        />
      )}
      {feedDebugPanelOpen && (
        <FeedDebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          onClose={toggleFeedDebugPanel}
        />
      )}
      {proxyDebugPanelOpen && (
        <ProxyDebugPanel sessionId={targetId} kind={kind} onClose={toggleProxyDebugPanel} />
      )}
      {htmlDebugPanelOpen && (
        <HtmlDebugPanel sessionId={targetId} kind={kind} onClose={toggleHtmlDebugPanel} />
      )}
      {devDebugEnabled && devDebugPanelOpen && (
        <DevDebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          workspace={workspace}
          onClose={toggleDevDebugPanel}
        />
      )}
    </>
  )
}
