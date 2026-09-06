import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'
import { SettingsPage } from '@renderer/features/settings/ui/SettingsPage'
import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { SpotlightView } from '@renderer/features/spotlight/ui/SpotlightView'
import { GlobalEditorShell } from '@renderer/features/global-editor/ui/GlobalEditorShell'
import { TileTabsView } from '@renderer/features/tile-tabs/ui/TileTabsView'
import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { TileTree } from '@renderer/workspace/tile-tree/TileTree'
import { NewAgentPlacementOverlay } from '@renderer/features/workspace/ui/NewAgentPlacementOverlay'
import { usePlacementOverlay } from '@renderer/features/workspace/surfaces/usePlacementOverlay'
import { RetainedWorkspaceSurface } from './RetainedWorkspaceSurface'
import { WelcomeEmpty } from './WelcomeEmpty'

// The main-area mode routing, extracted verbatim from App.tsx (#494).
//
// Active tab's tile tree OR welcome/fallback.
// We deliberately show WelcomeEmpty whenever activeTab is null —
// even if state.tabs.length > 0 — so a broken boot (e.g. a stale
// workspace.json with phantom sessions) still gives the user a
// clickable escape hatch. Otherwise the main area renders null
// and the app looks bricked.
export function MainSurface({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  const workspace = useWorkspaceLayoutContext()
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const resetSettings = useAppStore(state => state.resetSettings)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const placement = usePlacementOverlay()
  const { state, activeTab } = workspace
  const readerModeTabId = workspace.readerMode?.tabId ?? null
  const spotlightTabId = workspace.spotlight?.tabId ?? null
  const readerModeTabExists = readerModeTabId
    ? state.tabs.some(tab => tab.id === readerModeTabId)
    : false
  const spotlightTabExists = spotlightTabId
    ? state.tabs.some(tab => tab.id === spotlightTabId)
    : false

  // Exactly one takeover surface at a time, in the priority order the old
  // if/else ladder had. Settings wins over Reader wins over Spotlight.
  const takeover = settingsPageOpen
    ? 'settings'
    : workspace.readerMode && readerModeTabExists
      ? 'reader'
      : workspace.spotlight && spotlightTabExists
        ? 'spotlight'
        : null

  return (
    <>
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

        WHY the workspace is RETAINED, not replaced, under a takeover (#752):
          the takeover surfaces used to render instead of the shell, which
          unmounted every pane — every xterm disposed, every PTY detached,
          and on exit every terminal re-attached and replayed its whole
          buffer. RetainedWorkspaceSurface keeps the shell mounted under
          display:none while a takeover is active, the same way Global
          Editor fullscreen retains it, so leaving Reader Mode is a style
          change rather than a rebuild.

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
      {takeover === 'settings' ? (
        <SettingsPage
          onClose={closeSettingsPage}
          workspace={workspace}
          settings={settings}
          onChange={setSettings}
          onReset={resetSettings}
        />
      ) : takeover === 'reader' ? (
        <ReaderView workspace={workspace} />
      ) : takeover === 'spotlight' ? (
        <SpotlightView workspace={workspace} agentViewMode={settings.agentViewMode} />
      ) : null}
      <RetainedWorkspaceSurface hidden={takeover !== null}>
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
                open={placement.open}
                workspace={workspace}
                onClose={placement.close}
                attachIntent={placement.attachIntent}
                linkedAgentParentId={placement.linkedAgentParentId}
                projectIntent={placement.projectIntent}
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
                open={placement.open}
                workspace={workspace}
                onClose={placement.close}
                attachIntent={placement.attachIntent}
                linkedAgentParentId={placement.linkedAgentParentId}
                projectIntent={placement.projectIntent}
              />
            </div>
          ) : (
            <WelcomeEmpty onNewTabRequest={onNewTabRequest} />
          )}
        </GlobalEditorShell>
      </RetainedWorkspaceSurface>
    </>
  )
}
