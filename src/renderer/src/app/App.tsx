import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { useRenderedLeaseHygiene } from '@renderer/workspace/hook/effects/useRenderedLeaseHygiene'
import { useThemeSync } from '@renderer/features/settings/hooks/useThemeSync'
import { useAiWorkspaceOpenRequests } from '@renderer/features/global-editor/hooks/useAiWorkspaceOpenRequests'
import { useDevDebugConfigSync } from '@renderer/features/debug/devDebugConfig'
import { useDebugAutosave } from '@renderer/features/debug/useDebugAutosave'
import { useCaffeinateSync } from '@renderer/features/caffeinate/useCaffeinateSync'
import { useDictationHotkeySync } from '@renderer/features/voice-dictation/useDictationHotkeySync'
import { usePathPickerRequests } from '@renderer/features/path-picker/usePathPickerRequests'
import { GlobalModals } from '@renderer/app/surfaces/GlobalModals'
import { GlobalOverlays } from '@renderer/app/surfaces/GlobalOverlays'
import { SidePanels } from '@renderer/app/surfaces/SidePanels'
import { MainSurface, RestoreBanner, SettingsBar, SetupGate } from '@renderer/app/shell'

// App — the composition root, and ONLY that (issue #494).
//
// Responsibilities:
//   1. Cross-cutting sync hooks (theme, dev-debug, caffeinate,
//      dictation, ai-workspace doorbell) — each owned by its feature,
//      mounted exactly once here.
//   2. Instantiate the workspace hook (owns all tab/pane state + IPC)
//      and provide it via WorkspaceContext.
//   3. Register global keybinds.
//   4. Render the layout shell: banner → tab bar → settings bar →
//      main surface + side panels → overlays → modals.
//
// Every modal/overlay/panel mounts via app/surfaces/registry.tsx.
// ADDING A SURFACE MUST NOT EDIT THIS FILE — write a wrapper in the
// owning feature's surfaces/ folder and register it there. If you find
// yourself adding a useEffect here, it belongs in a feature hook.
export default function App() {
  // The only settings App itself reads are the useWorkspace() arguments —
  // everything else is consumed by the shell pieces / surfaces directly.
  const dangerousAgentsEnabled = useAppStore(state => state.settings.dangerousAgentsEnabled)
  const useProxyStreaming = useAppStore(state => state.settings.useProxyStreaming)
  const defaultWorkspaceMode = useAppStore(state => state.settings.defaultWorkspaceMode)
  const toggleCommandPalette = useAppStore(state => state.toggleCommandPalette)

  useThemeSync()
  useAiWorkspaceOpenRequests()
  useDevDebugConfigSync()
  useCaffeinateSync()
  useDictationHotkeySync()

  const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming, defaultWorkspaceMode)
  useRenderedLeaseHygiene(workspace)
  useDebugAutosave(workspace)

  const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()
  useKeybinds(workspace, onNewTabRequest, onResumeRequest, toggleCommandPalette)

  return (
    <WorkspaceProvider workspace={workspace}>
      <div className="relative h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
        <SetupGate />
        <RestoreBanner />
        <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />
        <SettingsBar />
        <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">
          <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <MainSurface onNewTabRequest={onNewTabRequest} />
          </main>
          <SidePanels />
        </div>
        <GlobalOverlays />
        <GlobalModals />
      </div>
    </WorkspaceProvider>
  )
}
