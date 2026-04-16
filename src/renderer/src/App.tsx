import { useCallback, useEffect } from 'react'

import { CommandPalette } from './CommandPalette'
import { DebugPanel } from './DebugPanel'
import { ProxyDebugPanel } from './ProxyDebugPanel'
import { SettingsPage } from './features/settings/ui/SettingsPage'
import { SpotlightView } from './features/spotlight/ui/SpotlightView'
import { ReaderView } from './features/reader/ui/ReaderView'
import { TileTabsModal } from './features/tile-tabs/ui/TileTabsModal'
import { TileTabsView } from './features/tile-tabs/ui/TileTabsView'
import { BuryPanePrompt } from './features/workspace/ui/BuryPanePrompt'
import { NewAgentPlacementOverlay } from './features/workspace/ui/NewAgentPlacementOverlay'
import { ViewPromptsModal } from './features/workspace/ui/ViewPromptsModal'
import { GitBar } from './GitBar'
import { AppearanceMenu } from './feed/AppearanceMenu'
import { PathPickerModal } from './tiles/PathPickerModal'
import { TabBar } from './tiles/TabBar'
import { TileTree } from './tiles/TileTree'
import { useAppStore } from './state/hooks'
import { applyTheme } from './state/settings/theme'
import { useKeybinds } from './tiles/useKeybinds'
import { useWorkspace } from './tiles/workspaceStore'

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
  const toggleCustomRendering = useAppStore(state => state.toggleCustomRendering)
  const pathPickerOpen = useAppStore(state => state.pathPickerOpen)
  const pathPickerDefault = useAppStore(state => state.pathPickerDefault)
  const commandPaletteOpen = useAppStore(state => state.commandPaletteOpen)
  const tileTabsModalOpen = useAppStore(state => state.tileTabsModalOpen)
  const tileTabsInitialSelectedIds = useAppStore(state => state.tileTabsInitialSelectedIds)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const buryPromptSessionId = useAppStore(state => state.buryPromptSessionId)
  const viewPromptsSessionId = useAppStore(state => state.viewPromptsSessionId)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const gitBarOpen = useAppStore(state => state.gitBarOpen)
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const useProxyStreaming = settings.useProxyStreaming
  const openPathPicker = useAppStore(state => state.openPathPicker)
  const closePathPicker = useAppStore(state => state.closePathPicker)
  const setPathPickerDefault = useAppStore(state => state.setPathPickerDefault)
  const openCommandPalette = useAppStore(state => state.openCommandPalette)
  const closeCommandPalette = useAppStore(state => state.closeCommandPalette)
  const toggleCommandPalette = useAppStore(state => state.toggleCommandPalette)
  const openTileTabsModal = useAppStore(state => state.openTileTabsModal)
  const closeTileTabsModal = useAppStore(state => state.closeTileTabsModal)
  const openSettingsPage = useAppStore(state => state.openSettingsPage)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const closeBuryPrompt = useAppStore(state => state.closeBuryPrompt)
  const openViewPrompts = useAppStore(state => state.openViewPrompts)
  const closeViewPrompts = useAppStore(state => state.closeViewPrompts)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const toggleGitBar = useAppStore(state => state.toggleGitBar)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)

  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming)

  // Pre-fill the path input with a sensible default when the modal
  // opens: the cwd of the most recently-used session, or main's
  // default cwd if no sessions exist yet. Cached so opening the modal
  // doesn't hit IPC every time.
  useEffect(() => {
    if (!pathPickerOpen) return
    const mostRecent = Object.values(workspace.state.sessions).pop()
    if (mostRecent?.cwd) {
      setPathPickerDefault(mostRecent.cwd)
      return
    }
    void window.api.defaultCwd().then(setPathPickerDefault)
  }, [pathPickerOpen, workspace.state.sessions])

  // New tab flow: show the path modal. On accept it calls workspace.newTab
  // with the expanded absolute path and closes the modal.
  const onNewTabRequest = useCallback(() => {
    openPathPicker()
  }, [openPathPicker])

  // Resume flow: same modal as new tab, but the default value is the
  // currently-focused tab's cwd so the resume list for that cwd is
  // visible immediately. This is the "continue where I was" shortcut.
  const onResumeRequest = useCallback(
    (defaultCwd: string) => {
      if (defaultCwd) {
        // Pre-fill with the current tab's cwd, bypassing the useEffect
        // that normally fills from "most recent session" — this is a
        // direct-to-resume flow and the default MUST reflect where
        // the user is standing.
        setPathPickerDefault(defaultCwd)
      }
      openPathPicker(defaultCwd)
    },
    [openPathPicker, setPathPickerDefault],
  )

  const onPathPickerAccept = useCallback(
    async (cwd: string, provider?: 'claude' | 'codex') => {
      await workspace.newTab(cwd, undefined, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  const onPathPickerResume = useCallback(
    async (cwd: string, sessionId: string, provider: 'claude' | 'codex') => {
      // Resume reuses newTab's plumbing — same workspace entry, same
      // tile tree shape — but passes the resume id through to the
      // spawn call so main spawns the selected provider with its
      // provider-native resume command.
      await workspace.newTab(cwd, sessionId, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  const onTileTabsRequest = useCallback(() => {
    openTileTabsModal(
      workspace.tileTabs?.tabIds ?? (workspace.activeTab ? [workspace.activeTab.id] : []),
    )
  }, [openTileTabsModal, workspace.activeTab, workspace.tileTabs])

  useKeybinds(workspace, onNewTabRequest, onResumeRequest, toggleCommandPalette)

  const { state, activeTab } = workspace
  const buriedPromptMeta = buryPromptSessionId
    ? workspace.state.sessions[buryPromptSessionId] ?? null
    : null

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
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
          {settingsPageOpen ? (
            <SettingsPage
              onClose={closeSettingsPage}
              workspace={workspace}
              settings={settings}
              onChange={setSettings}
              onReset={resetSettings}
            />
          ) : activeTab && workspace.readerMode && workspace.readerMode.tabId === activeTab.id ? (
            <ReaderView workspace={workspace} />
          ) : activeTab && workspace.spotlight && workspace.spotlight.tabId === activeTab.id ? (
            <SpotlightView workspace={workspace} />
          ) : workspace.tileTabs ? (
            <TileTabsView workspace={workspace} />
          ) : activeTab ? (
            <div className="relative h-full min-h-0 min-w-0">
              <TileTree
                tabId={activeTab.id}
                node={activeTab.root}
                focusedSessionId={activeTab.focusedSessionId}
                workspace={workspace}
              />
              <NewAgentPlacementOverlay
                open={newAgentPlacementOpen}
                workspace={workspace}
                onClose={closeNewAgentPlacement}
              />
            </div>
          ) : (
            <WelcomeEmpty onNewTabRequest={onNewTabRequest} />
          )}
        </main>

        {gitBarOpen && (
          <GitBar
            cwd={
              activeTab
                ? workspace.state.sessions[activeTab.focusedSessionId]?.cwd ?? null
                : null
            }
            onClose={toggleGitBar}
          />
        )}

        {debugPanelOpen && activeTab && (
          <DebugPanel
            sessionId={activeTab.focusedSessionId}
            runtime={workspace.getRuntime(activeTab.focusedSessionId)}
            kind={workspace.state.sessions[activeTab.focusedSessionId]?.kind ?? 'claude'}
            onClose={toggleDebugPanel}
          />
        )}

        {proxyDebugPanelOpen && activeTab && (
          <ProxyDebugPanel
            sessionId={activeTab.focusedSessionId}
            kind={workspace.state.sessions[activeTab.focusedSessionId]?.kind ?? 'claude'}
            onClose={toggleProxyDebugPanel}
          />
        )}
      </div>

      <CommandPalette
        open={commandPaletteOpen}
        onClose={closeCommandPalette}
        workspace={workspace}
        onNewTabRequest={onNewTabRequest}
        onResumeRequest={onResumeRequest}
        toggleGitBar={toggleGitBar}
        toggleDebugPanel={toggleDebugPanel}
        toggleProxyDebugPanel={toggleProxyDebugPanel}
        onTileTabsRequest={onTileTabsRequest}
        onSettingsRequest={openSettingsPage}
        openViewPrompts={openViewPrompts}
        toggleCustomRendering={toggleCustomRendering}
        customRenderingEnabled={settings.customRendering}
        dangerousAgentsEnabled={dangerousAgentsEnabled}
        setDangerousAgentsEnabled={enabled => setSettings({ dangerousAgentsEnabled: enabled })}
      />

      <PathPickerModal
        open={pathPickerOpen}
        defaultValue={pathPickerDefault}
        onCancel={closePathPicker}
        onAccept={onPathPickerAccept}
        onResume={onPathPickerResume}
      />

      <TileTabsModal
        open={tileTabsModalOpen}
        tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
        initialSelectedIds={tileTabsInitialSelectedIds}
        onCancel={closeTileTabsModal}
        onConfirm={tabIds => {
          workspace.openTileTabs(tabIds)
          closeTileTabsModal()
        }}
      />

      <BuryPanePrompt
        open={buryPromptSessionId !== null && buriedPromptMeta !== null}
        title={
          buriedPromptMeta
            ? `${buriedPromptMeta.kind ?? 'claude'} · ${buriedPromptMeta.cwd.split('/').filter(Boolean).pop() ?? buriedPromptMeta.cwd}`
            : ''
        }
        description={buriedPromptMeta?.cwd ?? ''}
        onCancel={closeBuryPrompt}
        onConfirm={note => {
          if (!buryPromptSessionId) return
          workspace.buryFocused(note, buryPromptSessionId)
        }}
      />

      <ViewPromptsModal
        open={viewPromptsSessionId !== null}
        sessionId={viewPromptsSessionId}
        workspace={workspace}
        onClose={closeViewPrompts}
      />

    </div>
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
