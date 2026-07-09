import { useCallback, useEffect, useRef } from 'react'

import { SettingsPage } from '@renderer/features/settings/ui/SettingsPage'
import { SetupGate } from '@renderer/features/setup/ui/SetupGate'
import { SpotlightView } from '@renderer/features/spotlight/ui/SpotlightView'
import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { TileTabsView } from '@renderer/features/tile-tabs/ui/TileTabsView'
import { NewAgentPlacementOverlay } from '@renderer/features/workspace/ui/NewAgentPlacementOverlay'
import { AppearanceMenu } from '@renderer/features/feed/AppearanceMenu'
import { usePathPickerRequests } from '@renderer/features/path-picker/usePathPickerRequests'
import { PerformancePanel } from '@renderer/features/performance/ui/PerformancePanel'
import { GlobalEditorShell } from '@renderer/features/global-editor/ui/GlobalEditorShell'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { SystemPerfHeader } from '@renderer/features/system-perf/ui/SystemPerfHeader'
import {
  AUTO_DEBUG_BUNDLE_INTERVAL_MS,
  autosaveActiveAgentDebugBundles,
} from '@renderer/features/debug/saveDebugBundle'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { TileTree } from '@renderer/workspace/tile-tree/TileTree'
import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCaffeinateStore } from '@renderer/features/caffeinate/store'
import { useDevDebugConfigSync } from '@renderer/features/debug/devDebugConfig'
import { useCaffeinateSync } from '@renderer/features/caffeinate/useCaffeinateSync'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import { GlobalModals } from '@renderer/app/surfaces/GlobalModals'
import { GlobalOverlays } from '@renderer/app/surfaces/GlobalOverlays'
import { SidePanels } from '@renderer/app/surfaces/SidePanels'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { useWorkspace } from '@renderer/workspace/workspaceStore'

// App — thin shell around the workspace hook.
//
// Responsibilities:
//   1. Apply the persisted theme before first render (no FOUC).
//   2. Instantiate the workspace hook (owns all tab/pane state + IPC).
//   3. Register global keybinds.
//   4. Render the tab bar on top and the active tab's tile tree below.
//   5. Wire the "new tab" flow (pickDirectory → newTab).
//
// Everything else — session spawning, per-pane input, feed rendering,
// streaming preview, trust modal — lives inside TileLeaf or the store.
// This file stays short on purpose.

export default function App() {
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const resetSettings = useAppStore(state => state.resetSettings)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const dispatchAttachIntent = useAppStore(state => state.dispatchAttachIntent)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const aggressiveDebugPersistenceEnabled = settings.aggressiveDebugPersistence
  const useProxyStreaming = settings.useProxyStreaming
  const defaultWorkspaceMode = settings.defaultWorkspaceMode
  const toggleCommandPalette = useAppStore(state => state.toggleCommandPalette)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const closeDispatchAttach = useAppStore(state => state.closeDispatchAttach)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  // Create, attach, and linked-agent flows share the same overlay
  // shell. The close handler clears every intent so re-opening one
  // mode after another never inherits stale state from a sibling flow.
  const closePlacementOverlay = useCallback(() => {
    closeNewAgentPlacement()
    closeDispatchAttach()
    closeLinkedAgent()
  }, [closeDispatchAttach, closeLinkedAgent, closeNewAgentPlacement])
  const placementOverlayOpen =
    newAgentPlacementOpen ||
    dispatchAttachIntent !== null ||
    linkedAgentParentId !== null
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const caffeinateStatus = useCaffeinateStore(state => state.status)
  const toggleCaffeinate = useCaffeinateStore(state => state.toggle)

  useEffect(() => {
    applyTheme(settings)
    void window.api.remoteSetThemeSettings(settings)
  }, [settings])

  useEffect(() => {
    const off = window.api.onAiWorkspaceOpenRequest(request => {
      useGlobalEditorStore.getState().openAiWorkspace(request.workspaceId)
      useAppStore.getState().openGlobalEditor()
    })
    return off
  }, [])

  useDevDebugConfigSync()
  useCaffeinateSync()

  useEffect(() => {
    // The default dictation trigger is bare Fn, which Chromium does not expose
    // reliably to renderer keydown. Settings live in the renderer, but the
    // actual capture must live in main/native; keep this one-way sync here so
    // every pane shares the same OS listener while the focused pane decides
    // whether to consume the resulting press/release event.
    const binding = settings.dictationEnabled ? settings.dictationShortcut : ''
    void window.api.configureDictationHotkey({ binding }).then(result => {
      if (!result.ok) {
        console.warn('[dictation] hotkey registration failed:', result)
      }
    })
  }, [settings.dictationEnabled, settings.dictationShortcut])

  const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming, defaultWorkspaceMode)
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(() => {
    if (settings.agentViewMode !== 'terminal') return
    // WHY hard Terminal mode force-clears rendered interaction state:
    // Hybrid leases are intentionally allowed to mount TileLeaf for a feature,
    // but Terminal mode is the user's explicit "do not mount Agent Code's
    // rendered agent surface" setting. If a picker lease survives the setting
    // transition, switching back to Hybrid later can resurrect a stale picker
    // that was invisible while Terminal mode was active. Clearing at the app
    // boundary keeps the mode switch semantic: Terminal is an immediate hard
    // reset of rendered-only affordances, not a pause button for them.
    for (const sessionId of Object.keys(workspace.runtimes)) {
      const runtime = workspace.runtimes[sessionId]
      if (runtime?.assistantPicker) workspace.pickerCancel(sessionId)
      if (runtime?.codeBlockPicker) workspace.setCodeBlockPicker(sessionId, null)
      workspace.releaseAllRenderedViewLeases(sessionId)
    }
  }, [settings.agentViewMode, workspace])

  useEffect(() => {
    // NOTE the field is `readerMode`, not `reader` (cross-app audit V1): the
    // workspace object never exposed a `reader` property, so the old guard read
    // `undefined`, collapsed to "spotlight OR settings only", and SKIPPED the
    // lease cleanup whenever Reader Mode was the surface hiding the feed. Reader
    // Mode replaces the feed interaction layer exactly like spotlight/settings,
    // so a surviving Copy-Assistant / Copy-Code-Block picker lease left
    // Escape/Enter/arrows acting on hidden state. This typo class is the reason
    // the cross-app audit calls for a typecheck gate — `workspace.reader`
    // compiled silently because nothing ran `tsc`.
    if (!workspace.readerMode && !workspace.spotlight && !settingsPageOpen) return
    // WHY reader/spotlight/settings clear picker leases:
    // these surfaces hide or replace the feed interaction layer while global
    // keybinds are still alive. If a Copy Assistant or Copy Code Block picker
    // survives underneath them, Escape/Enter/arrows either act on hidden state
    // or force Hybrid to keep TileLeaf mounted for UI the user cannot see.
    // Draft-driven rendering is intentionally unaffected because composer
    // draft text is real user state; picker leases are transient affordances.
    for (const sessionId of Object.keys(workspace.runtimes)) {
      const runtime = workspace.runtimes[sessionId]
      if (runtime?.assistantPicker) workspace.pickerCancel(sessionId)
      if (runtime?.codeBlockPicker) workspace.setCodeBlockPicker(sessionId, null)
      workspace.releaseRenderedViewLease(sessionId, 'copy-assistant-message')
      workspace.releaseRenderedViewLease(sessionId, 'copy-code-block')
    }
  }, [settingsPageOpen, workspace])

  useEffect(() => {
    if (!aggressiveDebugPersistenceEnabled) return

    let disposed = false
    let inFlight = false

    const saveAll = (reason: 'autosave-enabled' | 'autosave-interval' | 'autosave-beforeunload') => {
      if (inFlight && reason !== 'autosave-beforeunload') return
      inFlight = true
      void autosaveActiveAgentDebugBundles(workspaceRef.current, reason)
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn('[debug-autosave] failed', err)
        })
        .finally(() => {
          if (!disposed) inFlight = false
        })
    }

    // Take an immediate baseline when the mode is enabled so a crash
    // inside the first interval still leaves at least one bundle.
    saveAll('autosave-enabled')
    const timer = window.setInterval(
      () => saveAll('autosave-interval'),
      AUTO_DEBUG_BUNDLE_INTERVAL_MS,
    )
    const onBeforeUnload = () => {
      saveAll('autosave-beforeunload')
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [aggressiveDebugPersistenceEnabled])

  const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()

  useKeybinds(workspace, onNewTabRequest, onResumeRequest, toggleCommandPalette)

  const { state, activeTab } = workspace
  const readerModeTabId = workspace.readerMode?.tabId ?? null
  const spotlightTabId = workspace.spotlight?.tabId ?? null
  const readerModeTabExists = readerModeTabId
    ? state.tabs.some(tab => tab.id === readerModeTabId)
    : false
  const spotlightTabExists = spotlightTabId
    ? state.tabs.some(tab => tab.id === spotlightTabId)
    : false

  // WHY render this above TabBar instead of as a toast:
  //
  // The state being communicated is durable for the lifetime of the app
  // run, not a transient event — autosave is disabled until the user
  // restarts the app, so dismissing a toast would orphan the warning
  // while the underlying disk-protection invariant is still in effect.
  // A persistent banner above the tab bar matches how Electron desktop
  // apps surface "this run is degraded" state (e.g. update available),
  // and the user sees it on every interaction instead of having to
  // remember a toast they swatted at boot.
  const restoreBannerMessage: string | null =
    workspace.restoreStatus === 'partial-restore'
      ? 'Workspace partially restored — autosave is disabled to protect your saved state. Restart Agent Code after fixing the underlying spawn or proxy issue.'
      : workspace.restoreStatus === 'persisted-fallback'
        ? 'Could not load your saved workspace — running in a fresh-tab fallback. Autosave is disabled to avoid overwriting the on-disk file. Restart after resolving the issue.'
        : workspace.restoreStatus === 'bootstrap-error'
          ? 'Workspace bootstrap failed. Autosave is disabled. Check the dev console and restart Agent Code after fixing the underlying issue.'
          : null

  return (
    <WorkspaceProvider workspace={workspace}>
    <div className="relative h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
      <SetupGate />
      {restoreBannerMessage ? (
        <div
          role="alert"
          className="
            flex items-start gap-3 px-3 py-2
            border-b border-warning bg-warning/15 text-warning
            text-[11px] leading-snug font-code
            flex-shrink-0
          "
        >
          <span className="font-semibold uppercase tracking-wide">Autosave off</span>
          <span className="text-ink/90">{restoreBannerMessage}</span>
        </div>
      ) : null}
      {/* Tab bar */}
      <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />

      {/* Settings bar — compact row under tabs holding app chrome. */}
      <div
        className="
          flex items-center justify-end gap-3
          px-3 py-1.5
          border-b border-border bg-surface
          flex-shrink-0
          [-webkit-app-region:drag]
        "
      >
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <AppearanceMenu settings={settings} onChange={setSettings} />
          <button
            type="button"
            onClick={togglePerformancePanel}
            className={`
              px-2 py-1 border text-[10px] font-code transition-colors
              ${
                performancePanelOpen
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-border bg-surface-hi text-muted hover:text-ink'
              }
            `}
          >
            perf
          </button>
          <button
            type="button"
            disabled={caffeinateStatus?.supported === false}
            onClick={() => void toggleCaffeinate()}
            title={
              caffeinateStatus?.supported === false
                ? 'Caffeinate is only available on macOS.'
                : caffeinateStatus?.active
                  ? 'Caffeinate is active. Click to stop keeping the machine awake.'
                  : 'Start caffeinate to prevent idle sleep during long-running agent work.'
            }
            className={`
              px-2 py-1 border text-[10px] font-code transition-colors
              ${
                caffeinateStatus?.active
                  ? 'border-accent bg-accent text-accent-fg'
                  : caffeinateStatus?.supported === false
                    ? 'border-border bg-surface-hi text-muted/50 cursor-not-allowed'
                  : 'border-border bg-surface-hi text-muted hover:text-ink'
              }
            `}
          >
            caff
          </button>
          <PerformancePanel open={performancePanelOpen} workspace={workspace} />
          {/*
            Always-visible main-process heap + RSS badge with a 60s
            sparkline. Self-gates on AGENT_CODE_PERF — renders null
            until the first IPC probe confirms telemetry is on.
            Click expands to a PerformancePanel-sized popover with
            the full buffered window and growth rates.
          */}
          <SystemPerfHeader />
        </div>
      </div>

      {/*
        Active tab's tile tree OR welcome/fallback.
        We deliberately show WelcomeEmpty whenever activeTab is null —
        even if state.tabs.length > 0 — so a broken boot (e.g. a stale
        workspace.json with phantom sessions) still gives the user a
        clickable escape hatch. Otherwise the main area renders null
        and the app looks bricked.
      */}
      <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">
        <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
          {/*
            Mode routing — focus-takeover surfaces (Settings, Reader,
            Spotlight) render OUTSIDE the GlobalEditorShell. The shell
            only wraps surfaces that are meant to coexist with the
            editor (TileTabs, Dispatch, TileTree, WelcomeEmpty).

            WHY this split:
              Reader Mode and Spotlight Mode exist to give the user a
              full-bleed, distraction-free view of a single agent's
              transcript. Putting them inside the shell crammed them
              into the right half of the screen whenever the editor
              overlay was on — defeating the entire point of "focus
              mode." Settings is the same shape of surface (full-
              screen takeover; the user is configuring, not watching
              agents), so it bypasses too.

              The globalEditorOpen flag is deliberately NOT cleared
              when entering a focus mode. When the user exits Reader/
              Spotlight, the editor reappears automatically — that's
              the desired behaviour: focus modes are a temporary
              context, not a "close the editor" instruction.

            WHY TileTabs / Dispatch / TileTree stay inside the shell:
              These ARE the workspace. The point of the editor overlay
              is to be alongside them, so reading code does not require
              leaving the current mode.

            Keep the GlobalEditorShell mounted (rather than rendering
            it conditionally inside one branch) so the editor's
            in-memory state — open tabs, dirty buffers, scroll
            positions — survives toggling between Dispatch / TileTree
            and Welcome.
          */}
          {settingsPageOpen ? (
            <SettingsPage
              onClose={closeSettingsPage}
              workspace={workspace}
              settings={settings}
              onChange={setSettings}
              onReset={resetSettings}
            />
          ) : workspace.readerMode && readerModeTabExists ? (
            <ReaderView workspace={workspace} />
          ) : workspace.spotlight && spotlightTabExists ? (
            <SpotlightView workspace={workspace} agentViewMode={settings.agentViewMode} />
          ) : (
            <GlobalEditorShell workspace={workspace}>
              {workspace.tileTabs ? (
                <TileTabsView workspace={workspace} agentViewMode={settings.agentViewMode} />
              ) : activeTab && workspace.dispatchMode ? (
                <div className="relative h-full min-h-0 min-w-0">
                  <DispatchLayout
                    workspace={workspace}
                    agentViewMode={settings.agentViewMode}
                    showStatusMode={settings.showStatusMode}
                    showWorktreeBadges={settings.showWorktreeBadges}
                  />
                  <NewAgentPlacementOverlay
                    open={placementOverlayOpen}
                    workspace={workspace}
                    onClose={closePlacementOverlay}
                    attachIntent={dispatchAttachIntent}
                    linkedAgentParentId={linkedAgentParentId}
                  />
                </div>
              ) : activeTab ? (
                <div className="relative h-full min-h-0 min-w-0">
                  <TileTree
                    tabId={activeTab.id}
                    node={activeTab.root}
                    focusedSessionId={activeTab.focusedSessionId}
                    workspace={workspace}
                    agentViewMode={settings.agentViewMode}
                    showStatusMode={settings.showStatusMode}
                    showWorktreeBadges={settings.showWorktreeBadges}
                  />
                  <NewAgentPlacementOverlay
                    open={placementOverlayOpen}
                    workspace={workspace}
                    onClose={closePlacementOverlay}
                    attachIntent={dispatchAttachIntent}
                    linkedAgentParentId={linkedAgentParentId}
                  />
                </div>
              ) : (
                <WelcomeEmpty onNewTabRequest={onNewTabRequest} />
              )}
            </GlobalEditorShell>
          )}
        </main>

        <SidePanels />
      </div>

      <GlobalOverlays />


      <GlobalModals />
    </div>
    </WorkspaceProvider>
  )
}

// Shown when there are zero tabs — either first launch before the
// default session spawns, or the user closed everything.
function WelcomeEmpty({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="text-muted text-[12px]">no tabs open</div>
        <button
          type="button"
          onClick={onNewTabRequest}
          className="
            px-4 py-2 text-[12px]
            bg-accent text-accent-fg
            border border-accent
            hover:brightness-110
            transition-all duration-120
          "
        >
          new tab (⌘T)
        </button>
      </div>
    </div>
  )
}
