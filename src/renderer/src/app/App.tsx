import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import { useControlRegistration } from '@renderer/control/registerRendererHost'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { useRenderedLeaseHygiene } from '@renderer/workspace/hook/effects/useRenderedLeaseHygiene'
import { useThemeSync } from '@renderer/features/settings/hooks/useThemeSync'
import { useAiWorkspaceOpenRequests } from '@renderer/features/global-editor/hooks/useAiWorkspaceOpenRequests'
import { useEditorBeforeUnloadGuard } from '@renderer/features/global-editor/hooks/useEditorBeforeUnloadGuard'
import { useDevDebugConfigSync } from '@renderer/features/debug/devDebugConfig'
import { useDebugAutosave } from '@renderer/features/debug/useDebugAutosave'
import { useCaffeinateSync } from '@renderer/features/caffeinate/useCaffeinateSync'
import { useDictationHotkeySync } from '@renderer/features/voice-dictation/useDictationHotkeySync'
import { useDictationMouseTrigger } from '@renderer/features/voice-dictation/useDictationMouseTrigger'
import { useMouseChordPalette } from '@renderer/features/command-palette/useMouseChordPalette'
import { usePathPickerRequests } from '@renderer/features/path-picker/usePathPickerRequests'
import { useSelectionCapture } from '@renderer/features/reply-to-selection/useSelectionCapture'
import { GlobalModals } from '@renderer/app/surfaces/GlobalModals'
import { GlobalOverlays } from '@renderer/app/surfaces/GlobalOverlays'
import { SidePanels } from '@renderer/app/surfaces/SidePanels'
import { MainSurface } from '@renderer/app/shell/MainSurface'
import { AgentTerminalOwnershipProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { RestoreBanner } from '@renderer/app/shell/RestoreBanner'
import { ConfigureDictationCard } from '@renderer/features/voice-dictation/ConfigureDictationCard'
import { DictationGuideModal } from '@renderer/features/voice-dictation/DictationGuideModal'
import { SettingsBar } from '@renderer/app/shell/SettingsBar'
import { SetupGate } from '@renderer/features/setup/ui/SetupGate'
import { CliUpdateBanner } from '@renderer/features/cli-updates/CliUpdateBanner'
import { useCliUpdateSync } from '@renderer/features/cli-updates/store'

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
//
// Note the invariant is "no feature SURFACES mounted directly here",
// not "zero feature imports": App legitimately imports feature hooks
// (the sync hooks above) and SetupGate (a whole-app gate that wraps
// nothing and belongs to the frame, not the surface registry). An
// earlier revision laundered the SetupGate import through a shell
// barrel to claim zero feature imports — don't reintroduce that.
export default function App() {
  // The only settings App itself reads are the useWorkspace() arguments —
  // everything else is consumed by the shell pieces / surfaces directly.
  const dangerousAgentsEnabled = useAppStore(state => state.settings.dangerousAgentsEnabled)
  const useProxyStreaming = useAppStore(state => state.settings.useProxyStreaming)
  const defaultWorkspaceMode = useAppStore(state => state.settings.defaultWorkspaceMode)
  const defaultBuiltInMcpDomains = useAppStore(
    state => state.settings.defaultBuiltInMcpDomains,
  )

  useThemeSync()
  useAiWorkspaceOpenRequests()
  useEditorBeforeUnloadGuard()
  useDevDebugConfigSync()
  useCaffeinateSync()
  useDictationHotkeySync()
  useDictationMouseTrigger()
  // Mount order between these two no longer matters — both register with the
  // shared arbiter rather than installing their own window listeners, which is
  // the whole reason that module exists.
  useMouseChordPalette()
  // Fetch the initial CLI-update snapshot on mount and subscribe to
  // subsequent transitions. Same mount-once discipline as the other
  // sync hooks above — installing this in more than one place would
  // leak IPC listeners and double every state change.
  useCliUpdateSync()
  // Captures feed text selections for "Reply to Selection". Mounted here
  // for the same reason as the sync hooks above: `selectionchange` only
  // fires on `document`, so one listener serves every pane and Reader
  // Mode alike. Mounting it per-pane would mean N listeners filtering the
  // same global event.
  useSelectionCapture()

  const workspace = useWorkspace(
    dangerousAgentsEnabled,
    useProxyStreaming,
    defaultWorkspaceMode,
    defaultBuiltInMcpDomains,
  )
  useRenderedLeaseHygiene(workspace)
  useControlRegistration(workspace)
  useDebugAutosave(workspace)

  // New Tab, Resume Session and the palette toggle are ordinary commands now,
  // dispatched through the gateway by their configured bindings — the hook no
  // longer needs callbacks for them.
  // TabBar's "+" button and the empty-workspace surface still need the picker
  // callback; only the keyboard path became a routed command.
  const { onNewTabRequest } = usePathPickerRequests()
  useKeybinds(workspace)

  return (
    <WorkspaceProvider workspace={workspace}>
      <div className="relative h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
        <SetupGate />
        <RestoreBanner />
        {/* CLI updater banner. Sits above the tab bar next to
            RestoreBanner because both surfaces communicate "durable
            degraded state for this run" — the exact use case
            RestoreBanner's header comment names. Renders as null when
            neither CLI has anything to report. */}
        <CliUpdateBanner />
        {/* Voice dictation configuration nudge — soft banner that
            disappears once a Deepgram key exists or the user dismisses
            it. Renders null unless the API key is unconfigured. */}
        <ConfigureDictationCard />
        <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />
        <SettingsBar />
        <AgentTerminalOwnershipProvider>
          <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">
            <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <MainSurface onNewTabRequest={onNewTabRequest} />
            </main>
            <SidePanels />
          </div>
        </AgentTerminalOwnershipProvider>
        {/* Mount order here IS the z-order contract: overlays and modals
            are fixed-position siblings and mostly share z-50, so DOM
            order is the paint-order tiebreaker. Overlays render first
            (paint under); anything that must sit at a specific height
            within the modal stack lives in modalSurfaces at an explicit
            index — see app/surfaces/registry.tsx. Do not swap these. */}
        <GlobalOverlays />
        <GlobalModals />
        {/* Voice-dictation guide modal, opened by the "Configure Voice
            Dictation" nudge and by a future command-palette entry. Sits
            after GlobalModals in DOM order so it paints on top of the
            other overlay stacks without competing with the modalSurfaces
            registry — the guide is entirely local, no z-index tricks. */}
        <DictationGuideModal />
      </div>
    </WorkspaceProvider>
  )
}
