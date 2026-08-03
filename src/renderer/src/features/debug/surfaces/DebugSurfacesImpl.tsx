import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { DebugPanel } from '@renderer/features/debug/ui/DebugPanel'
import { FeedDebugPanel } from '@renderer/features/debug/ui/FeedDebugPanel'
import { ProxyDebugPanel } from '@renderer/features/debug/ui/ProxyDebugPanel'
import { HtmlDebugPanel } from '@renderer/features/debug/ui/HtmlDebugPanel'
import { DevDebugPanel } from '@renderer/features/debug/ui/DevDebugPanel'
import { RenderingDebugInspector } from '@renderer/features/debug/renderingDebug/RenderingDebugInspector'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { useDevDebugConfig } from '@renderer/features/debug/devDebugConfig'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { getEffectiveAgentSurface } from '@renderer/workspace/agentDisplayMode'

// The debug side surfaces, one block per panel flag, in the exact
// order App.tsx mounted them. Every surface needs the command-target session;
// each also carries its original guard (e.g. DevDebugPanel additionally
// requires the dev-debug config — that gate predates #494 and moves
// here untouched).
export function DebugSurfacesImpl() {
  const workspace = useWorkspaceContext()
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const renderingDebugMode = useAppStore(state => state.renderingDebugMode)
  const devDebugPanelOpen = useAppStore(state => state.devDebugPanelOpen)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleRenderingDebugMode = useAppStore(state => state.toggleRenderingDebugMode)
  const openDebugBundleNotePrompt = useAppStore(state => state.openDebugBundleNotePrompt)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const devDebugEnabled = useDevDebugConfig(state => state.enabled)

  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  const kind = workspace.state.sessions[targetId]?.kind ?? DEFAULT_PROVIDER
  const session = workspace.state.sessions[targetId]

  const saveRenderingElement = async (diagnosticJson: string): Promise<void> => {
    try {
      // Element snapshots use the established manual debug-bundle path rather
      // than a parallel storage directory. That gives them the same retention,
      // incident-run provenance, searchable ledger, portable note.json, and
      // filesystem safety checks as Save Debug Logs while keeping the actual
      // renderer capture in one purpose-specific file.
      const { bundlePath } = await window.api.saveDebugBundle({
        sessionId: targetId,
        kind,
        reason: 'rendering-element',
        cwd: session?.cwd ?? null,
        providerSessionId: session?.providerSessionId ?? null,
        files: [{ name: 'rendering-element.json', content: diagnosticJson }],
      })

      // Save must not replace a diagnostic the operator deliberately put on
      // the clipboard with Copy All. The path remains visible in both this
      // toast and the note prompt; clipboard mutation belongs to an explicit
      // copy affordance, not a button named only "Save".
      workspace.showPaneToast(targetId, `element saved · ${bundlePath}`, 6000)
      // This is intentionally the same note flow used by Save Debug Logs. The
      // snapshot is durable before the prompt opens, and Skip leaves a valid
      // uncommented artifact instead of discarding the evidence the user just
      // asked to preserve.
      openDebugBundleNotePrompt({
        bundlePath,
        sessionId: targetId,
        title: `Rendering element · ${kind}`,
        description: session?.cwd ?? '',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      workspace.showPaneToast(targetId, `element save failed: ${message}`, 5000)
      throw error
    }
  }

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
      {renderingDebugMode && (
        <RenderingDebugInspector
          sessionId={targetId}
          provider={isAgentProviderKind(kind) ? kind : 'unknown'}
          onSave={saveRenderingElement}
          onClose={toggleRenderingDebugMode}
        />
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
