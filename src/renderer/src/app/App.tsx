import { useCallback, useEffect, useRef } from 'react'

import { CommandPalette } from '@renderer/features/command-palette/ui/CommandPalette'
import { DebugPanel } from '@renderer/features/debug/ui/DebugPanel'
import { FeedDebugPanel } from '@renderer/features/debug/ui/FeedDebugPanel'
import { HtmlDebugPanel } from '@renderer/features/debug/ui/HtmlDebugPanel'
import { ProxyDebugPanel } from '@renderer/features/debug/ui/ProxyDebugPanel'
import { SettingsPage } from '@renderer/features/settings/ui/SettingsPage'
import { SetupGate } from '@renderer/features/setup/ui/SetupGate'
import { SpotlightView } from '@renderer/features/spotlight/ui/SpotlightView'
import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { TileTabsModal } from '@renderer/features/tile-tabs/ui/TileTabsModal'
import { TileTabsView } from '@renderer/features/tile-tabs/ui/TileTabsView'
import { AgentActivityModal } from '@renderer/features/workspace/ui/AgentActivityModal'
import { BuryPanePrompt } from '@renderer/features/workspace/ui/BuryPanePrompt'
import { NewAgentPlacementOverlay } from '@renderer/features/workspace/ui/NewAgentPlacementOverlay'
import { PromptSearchModal } from '@renderer/features/workspace/ui/PromptSearchModal'
import { RewindToPromptModal } from '@renderer/features/workspace/ui/RewindToPromptModal'
import { ViewPromptsModal } from '@renderer/features/workspace/ui/ViewPromptsModal'
import { GitBar } from '@renderer/features/git/ui/GitBar'
import { WorktreesBar } from '@renderer/features/worktrees/ui/WorktreesBar'
import { AppearanceMenu } from '@renderer/features/feed/AppearanceMenu'
import { PathPickerModal } from '@renderer/features/path-picker/ui/PathPickerModal'
import { PerformancePanel } from '@renderer/features/performance/ui/PerformancePanel'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { TileTree } from '@renderer/workspace/tile-tree/TileTree'
import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { useAppStore } from '@renderer/app-state/hooks'
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
  const toggleCustomRendering = useAppStore(state => state.toggleCustomRendering)
  const toggleStatusMode = useAppStore(state => state.toggleStatusMode)
  const toggleWorktreeBadges = useAppStore(state => state.toggleWorktreeBadges)
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
  const worktreesBarOpen = useAppStore(state => state.worktreesBarOpen)
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const useProxyStreaming = settings.useProxyStreaming
  const defaultWorkspaceMode = settings.defaultWorkspaceMode
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
  const toggleWorktreesBar = useAppStore(state => state.toggleWorktreesBar)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const promptSearchOpen = useAppStore(state => state.promptSearchOpen)
  const openPromptSearch = useAppStore(state => state.openPromptSearch)
  const closePromptSearch = useAppStore(state => state.closePromptSearch)
  const agentActivityOpen = useAppStore(state => state.agentActivityOpen)
  const openAgentActivity = useAppStore(state => state.openAgentActivity)
  const closeAgentActivity = useAppStore(state => state.closeAgentActivity)
  const rewindPromptSessionId = useAppStore(state => state.rewindPromptSessionId)
  const openRewindPrompt = useAppStore(state => state.openRewindPrompt)
  const closeRewindPrompt = useAppStore(state => state.closeRewindPrompt)

  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming, defaultWorkspaceMode)
  const pathPickerDefaultedRef = useRef(false)

  // Pre-fill the path input once per modal open. Do not keep syncing
  // while the modal is visible: newTab/resume mutates workspace
  // sessions before the modal closes, and re-syncing here resets the
  // picker mid-submit. Also preserve explicit defaults from the
  // resume shortcut.
  useEffect(() => {
    if (!pathPickerOpen) {
      pathPickerDefaultedRef.current = false
      return
    }
    if (pathPickerDefaultedRef.current) return
    pathPickerDefaultedRef.current = true
    if (pathPickerDefault) return

    let cancelled = false
    const mostRecent = Object.values(workspace.state.sessions).pop()
    if (mostRecent?.cwd) {
      setPathPickerDefault(mostRecent.cwd)
      return
    }
    void window.api.defaultCwd().then(cwd => {
      if (!cancelled) setPathPickerDefault(cwd)
    })
    return () => {
      cancelled = true
    }
  }, [pathPickerDefault, pathPickerOpen, setPathPickerDefault, workspace.state.sessions])

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
    <div className="relative h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
      <SetupGate />
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
          <PerformancePanel open={performancePanelOpen} workspace={workspace} />
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
          ) : activeTab && workspace.dispatchMode ? (
            <div className="relative h-full min-h-0 min-w-0">
              <DispatchLayout
                workspace={workspace}
                showStatusMode={settings.showStatusMode}
                showWorktreeBadges={settings.showWorktreeBadges}
              />
            </div>
          ) : activeTab ? (
            <div className="relative h-full min-h-0 min-w-0">
              <TileTree
                tabId={activeTab.id}
                node={activeTab.root}
                focusedSessionId={activeTab.focusedSessionId}
                workspace={workspace}
                showStatusMode={settings.showStatusMode}
                showWorktreeBadges={settings.showWorktreeBadges}
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

        {worktreesBarOpen && (
          <WorktreesBar
            cwd={
              activeTab
                ? workspace.state.sessions[activeTab.focusedSessionId]?.cwd ?? null
                : null
            }
            workspace={workspace}
            onClose={toggleWorktreesBar}
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

        {feedDebugPanelOpen && activeTab && (
          <FeedDebugPanel
            sessionId={activeTab.focusedSessionId}
            runtime={workspace.getRuntime(activeTab.focusedSessionId)}
            kind={workspace.state.sessions[activeTab.focusedSessionId]?.kind ?? 'claude'}
            onClose={toggleFeedDebugPanel}
          />
        )}

        {proxyDebugPanelOpen && activeTab && (
          <ProxyDebugPanel
            sessionId={activeTab.focusedSessionId}
            kind={workspace.state.sessions[activeTab.focusedSessionId]?.kind ?? 'claude'}
            onClose={toggleProxyDebugPanel}
          />
        )}

        {htmlDebugPanelOpen && activeTab && (
          <HtmlDebugPanel
            sessionId={activeTab.focusedSessionId}
            kind={workspace.state.sessions[activeTab.focusedSessionId]?.kind ?? 'claude'}
            onClose={toggleHtmlDebugPanel}
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
        toggleWorktreesBar={toggleWorktreesBar}
        toggleDebugPanel={toggleDebugPanel}
        toggleFeedDebugPanel={toggleFeedDebugPanel}
        toggleProxyDebugPanel={toggleProxyDebugPanel}
        toggleHtmlDebugPanel={toggleHtmlDebugPanel}
        togglePerformancePanel={togglePerformancePanel}
        enterDispatchMode={workspace.enterDispatchMode}
        enterGlobalDispatch={() =>
          workspace.setDispatchScope(
            workspace.dispatchMode?.scope === 'global' ? 'project' : 'global',
          )
        }
        exitDispatchMode={workspace.exitDispatchMode}
        toggleDispatchTerminal={workspace.toggleDispatchTerminal}
        onTileTabsRequest={onTileTabsRequest}
        onSettingsRequest={openSettingsPage}
        openViewPrompts={openViewPrompts}
        openPromptSearch={openPromptSearch}
        openAgentActivity={openAgentActivity}
        openRewindPrompt={openRewindPrompt}
        toggleCustomRendering={toggleCustomRendering}
        toggleStatusMode={toggleStatusMode}
        toggleWorktreeBadges={toggleWorktreeBadges}
        customRenderingEnabled={settings.customRendering}
        statusModeEnabled={settings.showStatusMode}
        worktreeBadgesEnabled={settings.showWorktreeBadges}
        dangerousAgentsEnabled={dangerousAgentsEnabled}
        gitBarOpen={gitBarOpen}
        worktreesBarOpen={worktreesBarOpen}
        debugPanelOpen={debugPanelOpen}
        feedDebugPanelOpen={feedDebugPanelOpen}
        proxyDebugPanelOpen={proxyDebugPanelOpen}
        htmlDebugPanelOpen={htmlDebugPanelOpen}
        performancePanelOpen={performancePanelOpen}
        dispatchModeEnabled={workspace.dispatchMode !== null}
        globalDispatchEnabled={workspace.dispatchMode?.scope === 'global'}
        dispatchTerminalVisible={workspace.dispatchMode?.terminalVisible !== false}
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

      <PromptSearchModal
        open={promptSearchOpen}
        workspace={workspace}
        onClose={closePromptSearch}
      />

      <AgentActivityModal
        open={agentActivityOpen}
        workspace={workspace}
        onClose={closeAgentActivity}
      />

      <RewindToPromptModal
        open={rewindPromptSessionId !== null}
        sessionId={rewindPromptSessionId}
        workspace={workspace}
        onClose={closeRewindPrompt}
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
