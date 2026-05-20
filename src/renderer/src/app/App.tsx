import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CommandPalette } from '@renderer/features/command-palette/ui/CommandPalette'
import { AgentStatusPanel } from '@renderer/features/agent-status/ui/AgentStatusPanel'
import { PinAgentsModal, type PinAgentsModalRow } from '@renderer/features/dispatch-pin/PinAgentsModal'
import { DebugPanel } from '@renderer/features/debug/ui/DebugPanel'
import { DebugBundleNotePrompt } from '@renderer/features/debug/ui/DebugBundleNotePrompt'
import { FeedDebugPanel } from '@renderer/features/debug/ui/FeedDebugPanel'
import { HtmlDebugPanel } from '@renderer/features/debug/ui/HtmlDebugPanel'
import { ProxyDebugPanel } from '@renderer/features/debug/ui/ProxyDebugPanel'
import { DevDebugPanel } from '@renderer/features/debug/ui/DevDebugPanel'
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
import { ReorderTabsModal } from '@renderer/features/workspace/ui/ReorderTabsModal'
import { RewindToPromptModal } from '@renderer/features/workspace/ui/RewindToPromptModal'
import { ViewPromptsModal } from '@renderer/features/workspace/ui/ViewPromptsModal'
import { GitBar } from '@renderer/features/git/ui/GitBar'
import { WorktreesBar } from '@renderer/features/worktrees/ui/WorktreesBar'
import { AppearanceMenu } from '@renderer/features/feed/AppearanceMenu'
import { PathPickerModal } from '@renderer/features/path-picker/ui/PathPickerModal'
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
import { applyTheme } from '@renderer/app-state/settings/theme'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, TabId } from '@renderer/workspace/types'
import type { CaffeinateStatus } from '@preload/index'

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
  const reorderTabsOpen = useAppStore(state => state.reorderTabsOpen)
  const pinAgentsOpen = useAppStore(state => state.pinAgentsOpen)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const buryPromptSessionId = useAppStore(state => state.buryPromptSessionId)
  const debugBundleNotePrompt = useAppStore(state => state.debugBundleNotePrompt)
  const viewPromptsSessionId = useAppStore(state => state.viewPromptsSessionId)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const dispatchAttachIntent = useAppStore(state => state.dispatchAttachIntent)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  const gitBarOpen = useAppStore(state => state.gitBarOpen)
  const worktreesBarOpen = useAppStore(state => state.worktreesBarOpen)
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const devDebugPanelOpen = useAppStore(state => state.devDebugPanelOpen)
  const agentStatusPanelOpen = useAppStore(state => state.agentStatusPanelOpen)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const globalEditorOpen = useAppStore(state => state.globalEditorOpen)
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const aggressiveDebugPersistenceEnabled = settings.aggressiveDebugPersistence
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
  const openReorderTabs = useAppStore(state => state.openReorderTabs)
  const closeReorderTabs = useAppStore(state => state.closeReorderTabs)
  const openPinAgents = useAppStore(state => state.openPinAgents)
  const closePinAgents = useAppStore(state => state.closePinAgents)
  const openSettingsPage = useAppStore(state => state.openSettingsPage)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const closeBuryPrompt = useAppStore(state => state.closeBuryPrompt)
  const closeDebugBundleNotePrompt = useAppStore(state => state.closeDebugBundleNotePrompt)
  const openViewPrompts = useAppStore(state => state.openViewPrompts)
  const closeViewPrompts = useAppStore(state => state.closeViewPrompts)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const closeDispatchAttach = useAppStore(state => state.closeDispatchAttach)
  const openDispatchAttach = useAppStore(state => state.openDispatchAttach)
  const openLinkedAgent = useAppStore(state => state.openLinkedAgent)
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
  const toggleGitBar = useAppStore(state => state.toggleGitBar)
  const toggleWorktreesBar = useAppStore(state => state.toggleWorktreesBar)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const openAgentStatusPanel = useAppStore(state => state.openAgentStatusPanel)
  const closeAgentStatusPanel = useAppStore(state => state.closeAgentStatusPanel)
  const toggleAgentStatusPanel = useAppStore(state => state.toggleAgentStatusPanel)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const toggleGlobalEditor = useAppStore(state => state.toggleGlobalEditor)
  // File-tree visibility lives on the global-editor store, not on
  // uiShell, because it's editor-scoped state — the rest of the
  // workspace has no concept of "the file tree." We subscribe here
  // only to thread the flag + action to the command palette, which
  // shows the toggle when the Global Editor is open.
  const fileTreeVisible = useGlobalEditorStore(state => state.fileTreeVisible)
  const toggleFileTreeVisible = useGlobalEditorStore(state => state.toggleFileTreeVisible)
  const promptSearchOpen = useAppStore(state => state.promptSearchOpen)
  const openPromptSearch = useAppStore(state => state.openPromptSearch)
  const closePromptSearch = useAppStore(state => state.closePromptSearch)
  const agentActivityOpen = useAppStore(state => state.agentActivityOpen)
  const openAgentActivity = useAppStore(state => state.openAgentActivity)
  const closeAgentActivity = useAppStore(state => state.closeAgentActivity)
  const rewindPromptSessionId = useAppStore(state => state.rewindPromptSessionId)
  const openRewindPrompt = useAppStore(state => state.openRewindPrompt)
  const closeRewindPrompt = useAppStore(state => state.closeRewindPrompt)
  const [devDebugEnabled, setDevDebugEnabled] = useState(false)
  const [caffeinateStatus, setCaffeinateStatus] = useState<CaffeinateStatus | null>(null)
  const [caffeinateMessage, setCaffeinateMessage] = useState<string | null>(null)

  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  useEffect(() => {
    const off = window.api.onAiWorkspaceOpenRequest(request => {
      useGlobalEditorStore.getState().openAiWorkspace(request.workspaceId)
      useAppStore.getState().openGlobalEditor()
    })
    return off
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.getDevDebugConfig()
      .then(config => {
        if (!cancelled) setDevDebugEnabled(config.enabled)
      })
      .catch(() => {
        if (!cancelled) setDevDebugEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.getCaffeinateStatus()
      .then(status => {
        if (!cancelled) setCaffeinateStatus(status)
      })
      .catch(() => {
        if (!cancelled) {
          setCaffeinateStatus({
            supported: false,
            active: false,
            pid: null,
            startedAt: null,
            command: [],
            message: 'Could not read caffeinate status.',
          })
        }
      })
    const off = window.api.onCaffeinateStateChanged(status => {
      setCaffeinateStatus(status)
      setCaffeinateMessage(status.message)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const toggleCaffeinate = useCallback(async () => {
    const result = await window.api.toggleCaffeinate()
    setCaffeinateStatus(result.status)
    setCaffeinateMessage(result.message)
  }, [])

  useEffect(() => {
    if (!caffeinateMessage) return
    const timer = window.setTimeout(() => setCaffeinateMessage(null), 5000)
    return () => window.clearTimeout(timer)
  }, [caffeinateMessage])

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
  const pathPickerDefaultedRef = useRef(false)

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

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
    // Pre-fill from the active tab's context, not a global "most
    // recent session" walk. The old code did
    // `Object.values(state.sessions).pop()` which returns the last
    // inserted session across ALL tabs — once Dispatch Mode landed,
    // that's frequently a background detached agent in a different
    // project, and the user opens the new-tab picker pre-filled with
    // a directory they aren't standing in. Prefer (a) the active
    // tab's focused session, (b) the first session resolved for the
    // active tab by the canonical resolver. Falls through to
    // window.api.defaultCwd() when the active tab has no sessions.
    const activeTabId = workspace.activeTab?.id
    let fallbackCwd: string | undefined
    if (activeTabId) {
      const focusedId = workspace.activeTab?.focusedSessionId ?? null
      const candidateId = focusedId ?? resolveTabSessions(workspace.state, activeTabId)[0] ?? null
      if (candidateId) {
        fallbackCwd = workspace.state.sessions[candidateId]?.cwd
      }
    }
    if (fallbackCwd) {
      setPathPickerDefault(fallbackCwd)
      return
    }
    void window.api.defaultCwd().then(cwd => {
      if (!cancelled) setPathPickerDefault(cwd)
    })
    return () => {
      cancelled = true
    }
  }, [pathPickerDefault, pathPickerOpen, setPathPickerDefault, workspace.activeTab, workspace.state])

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
  const commandTargetId = commandTargetSessionId(workspace)

  // Candidate rows for the Pin Agents modal. Built here (not inside
  // the modal) because we already have cheap access to the full
  // workspace state via the workspace hook — the modal stays a dumb
  // props-driven component.
  //
  // Ordering: currently-pinned agents first in pin order, then
  // everyone else tab-by-tab in tab order. Pinned-first means the
  // user's existing pins surface at the top when they open the
  // modal — the most common operation is "tweak my pins," not
  // "scroll through every agent in the workspace."
  //
  // Terminals are excluded: pin reducer / sanity effect / modal
  // selection all agree pins are agents. Detached agents ARE
  // included — they're the ones the user is most likely pinning
  // (background work they want one keystroke away).
  const pinAgentsRows = useMemo<PinAgentsModalRow[]>(() => {
    const rows: PinAgentsModalRow[] = []
    const pinnedSet = new Set(state.pinnedSessionIds)
    const seen = new Set<SessionId>()

    const tabIndexFor = (tabId: TabId): number => state.tabs.findIndex(tab => tab.id === tabId)

    const pushRow = (sessionId: SessionId, tabId: TabId): void => {
      if (seen.has(sessionId)) return
      const meta = state.sessions[sessionId]
      if (!meta || meta.kind === 'terminal') return
      const tabIndex = tabIndexFor(tabId)
      const tab = state.tabs[tabIndex]
      if (!tab) return
      seen.add(sessionId)
      rows.push({
        sessionId,
        tabIndex,
        tabTitle: tab.title,
        // Same title fallback the dispatch selectors use — keep this
        // in sync if the title source ever changes. Inlined rather
        // than importing the selector helper because it's two lines.
        title: meta.title?.trim() || meta.cwd?.split('/').filter(Boolean).pop() || 'agent',
      })
    }

    // Pass 1: pinned ids, in pin order. Owner-tab lookup goes through
    // resolveTabSessions so it sees BOTH grid leaves and detached
    // agents owned by the tab. The previous code branched on
    // `state.detachedSessions[sessionId]` before falling back to a
    // grid-only `collectLeaves` walk — the same divergence pattern
    // this whole PR is closing.
    for (const sessionId of state.pinnedSessionIds) {
      const owner = state.tabs.find(tab => resolveTabSessions(state, tab.id).includes(sessionId))
      if (owner) pushRow(sessionId, owner.id)
    }

    // Pass 2: every other agent, tab-by-tab. resolveTabSessions
    // already yields grid leaves first (in tile-tree order) then
    // detached agents oldest-first — exactly the order this modal
    // wants — so no manual interleaving is needed. The pinnedSet
    // check is belt-and-suspenders since `seen` would also catch
    // double-adds, but it makes the intent obvious to a future
    // reader.
    for (const tab of state.tabs) {
      for (const sessionId of resolveTabSessions(state, tab.id)) {
        if (pinnedSet.has(sessionId)) continue
        pushRow(sessionId, tab.id)
      }
    }

    return rows
  }, [
    state.detachedSessions,
    state.pinnedSessionIds,
    state.sessions,
    state.tabs,
  ])
  const buriedPromptMeta = buryPromptSessionId
    ? workspace.state.sessions[buryPromptSessionId] ?? null
    : null

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
          ) : activeTab && workspace.readerMode && workspace.readerMode.tabId === activeTab.id ? (
            <ReaderView workspace={workspace} />
          ) : activeTab && workspace.spotlight && workspace.spotlight.tabId === activeTab.id ? (
            <SpotlightView workspace={workspace} />
          ) : (
            <GlobalEditorShell workspace={workspace}>
              {workspace.tileTabs ? (
                <TileTabsView workspace={workspace} />
              ) : activeTab && workspace.dispatchMode ? (
                <div className="relative h-full min-h-0 min-w-0">
                  <DispatchLayout
                    workspace={workspace}
                    showStatusMode={settings.showStatusMode}
                    showWorktreeBadges={settings.showWorktreeBadges}
                  />
                  <NewAgentPlacementOverlay
                    open={placementOverlayOpen}
                    workspace={workspace}
                    onClose={closePlacementOverlay}
                    attachDetachedSessionId={dispatchAttachIntent}
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
                    showStatusMode={settings.showStatusMode}
                    showWorktreeBadges={settings.showWorktreeBadges}
                  />
                  <NewAgentPlacementOverlay
                    open={placementOverlayOpen}
                    workspace={workspace}
                    onClose={closePlacementOverlay}
                    attachDetachedSessionId={dispatchAttachIntent}
                    linkedAgentParentId={linkedAgentParentId}
                  />
                </div>
              ) : (
                <WelcomeEmpty onNewTabRequest={onNewTabRequest} />
              )}
            </GlobalEditorShell>
          )}
        </main>

        {gitBarOpen && (
          <GitBar
            cwd={
              commandTargetId
                ? workspace.state.sessions[commandTargetId]?.cwd ?? null
                : null
            }
            onClose={toggleGitBar}
          />
        )}

        {worktreesBarOpen && (
          <WorktreesBar
            cwd={
              commandTargetId
                ? workspace.state.sessions[commandTargetId]?.cwd ?? null
                : null
            }
            workspace={workspace}
            onClose={toggleWorktreesBar}
          />
        )}

        {agentStatusPanelOpen && commandTargetId && (
          <AgentStatusPanel
            sessionId={commandTargetId}
            workspace={workspace}
            onClose={closeAgentStatusPanel}
          />
        )}

        {debugPanelOpen && commandTargetId && (
          <DebugPanel
            sessionId={commandTargetId}
            runtime={workspace.getRuntime(commandTargetId)}
            kind={workspace.state.sessions[commandTargetId]?.kind ?? 'claude'}
            onClose={toggleDebugPanel}
          />
        )}

        {feedDebugPanelOpen && commandTargetId && (
          <FeedDebugPanel
            sessionId={commandTargetId}
            runtime={workspace.getRuntime(commandTargetId)}
            kind={workspace.state.sessions[commandTargetId]?.kind ?? 'claude'}
            onClose={toggleFeedDebugPanel}
          />
        )}

        {proxyDebugPanelOpen && commandTargetId && (
          <ProxyDebugPanel
            sessionId={commandTargetId}
            kind={workspace.state.sessions[commandTargetId]?.kind ?? 'claude'}
            onClose={toggleProxyDebugPanel}
          />
        )}

        {htmlDebugPanelOpen && commandTargetId && (
          <HtmlDebugPanel
            sessionId={commandTargetId}
            kind={workspace.state.sessions[commandTargetId]?.kind ?? 'claude'}
            onClose={toggleHtmlDebugPanel}
          />
        )}

        {devDebugEnabled && devDebugPanelOpen && commandTargetId && (
          <DevDebugPanel
            sessionId={commandTargetId}
            runtime={workspace.getRuntime(commandTargetId)}
            kind={workspace.state.sessions[commandTargetId]?.kind ?? 'claude'}
            workspace={workspace}
            onClose={toggleDevDebugPanel}
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
        toggleDevDebugPanel={toggleDevDebugPanel}
        openAgentStatusPanel={openAgentStatusPanel}
        closeAgentStatusPanel={closeAgentStatusPanel}
        toggleAgentStatusPanel={toggleAgentStatusPanel}
        togglePerformancePanel={togglePerformancePanel}
        toggleCaffeinate={toggleCaffeinate}
        toggleGlobalEditor={toggleGlobalEditor}
        toggleFileTreeVisible={toggleFileTreeVisible}
        enterDispatchMode={workspace.enterDispatchMode}
        enterGlobalDispatch={() =>
          workspace.setDispatchScope(
            workspace.dispatchMode?.scope === 'global' ? 'project' : 'global',
          )
        }
        exitDispatchMode={workspace.exitDispatchMode}
        openDispatchAttach={openDispatchAttach}
        openLinkedAgent={openLinkedAgent}
        openPinAgents={openPinAgents}
        onTileTabsRequest={onTileTabsRequest}
        onReorderTabsRequest={openReorderTabs}
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
        aggressiveDebugPersistenceEnabled={aggressiveDebugPersistenceEnabled}
        gitBarOpen={gitBarOpen}
        worktreesBarOpen={worktreesBarOpen}
        debugPanelOpen={debugPanelOpen}
        feedDebugPanelOpen={feedDebugPanelOpen}
        proxyDebugPanelOpen={proxyDebugPanelOpen}
        htmlDebugPanelOpen={htmlDebugPanelOpen}
        devDebugEnabled={devDebugEnabled}
        devDebugPanelOpen={devDebugPanelOpen}
        agentStatusPanelOpen={agentStatusPanelOpen}
        performancePanelOpen={performancePanelOpen}
        caffeinateActive={caffeinateStatus?.active === true}
        caffeinateSupported={caffeinateStatus?.supported !== false}
        globalEditorOpen={globalEditorOpen}
        fileTreeVisible={fileTreeVisible}
        dispatchModeEnabled={workspace.dispatchMode !== null}
        globalDispatchEnabled={workspace.dispatchMode?.scope === 'global'}
        setDangerousAgentsEnabled={enabled => setSettings({ dangerousAgentsEnabled: enabled })}
        setAggressiveDebugPersistence={enabled =>
          setSettings({ aggressiveDebugPersistence: enabled })}
      />

      <PathPickerModal
        open={pathPickerOpen}
        defaultValue={pathPickerDefault}
        onCancel={closePathPicker}
        onAccept={onPathPickerAccept}
        onResume={onPathPickerResume}
      />

      {caffeinateMessage ? (
        <div
          role="status"
          className="
            fixed bottom-3 right-3 z-50 max-w-[360px]
            border border-border bg-surface-hi px-3 py-2
            text-[11px] leading-snug text-ink shadow-lg
          "
        >
          <div className="font-semibold uppercase tracking-wide text-muted">
            Caffeinate
          </div>
          <div>{caffeinateMessage}</div>
        </div>
      ) : null}

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

      <ReorderTabsModal
        open={reorderTabsOpen}
        tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
        activeTabId={workspace.state.activeTabId}
        onCancel={closeReorderTabs}
        onConfirm={tabIds => {
          workspace.reorderTabs(tabIds)
          closeReorderTabs()
        }}
      />

      <PinAgentsModal
        open={pinAgentsOpen}
        rows={pinAgentsRows}
        initialSelectedIds={workspace.state.pinnedSessionIds}
        onCancel={closePinAgents}
        onConfirm={ids => {
          workspace.setPinnedSessionIds(ids)
          closePinAgents()
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

      <DebugBundleNotePrompt
        open={debugBundleNotePrompt !== null}
        title={debugBundleNotePrompt?.title ?? ''}
        description={debugBundleNotePrompt?.description ?? ''}
        bundlePath={debugBundleNotePrompt?.bundlePath ?? ''}
        onCancel={closeDebugBundleNotePrompt}
        onConfirm={note => {
          const prompt = debugBundleNotePrompt
          if (!prompt) return
          const trimmed = note.trim()
          closeDebugBundleNotePrompt()
          if (!trimmed) return
          void window.api.addDebugBundleNote({
            bundlePath: prompt.bundlePath,
            note: trimmed,
          }).then(
            () => workspace.showPaneToast(prompt.sessionId, 'debug note saved', 3000),
            err => {
              const message = err instanceof Error ? err.message : String(err)
              workspace.showPaneToast(prompt.sessionId, `debug note failed: ${message}`, 5000)
            },
          )
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
