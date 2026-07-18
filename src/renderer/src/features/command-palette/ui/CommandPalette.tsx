import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { buildCommandRegistry } from '@renderer/features/command-palette/registry'
import {
  buildAgentIndexCommand,
  isAgentIndexCommand,
} from '@renderer/features/command-palette/lib/agentIndexCommand'
import {
  buildHistoryScoreMap,
  loadRecentHistory,
  recordCommandUse,
} from '@renderer/features/command-palette/lib/recentCommandHistory'
import { fuzzyMatch, rankCommands } from '@renderer/features/command-palette/lib/rankCommands'
import type { CommandContext, ResolvedCommand } from '@renderer/features/command-palette/types'
import {
  allPromptTemplates,
  deleteCustomPromptTemplate,
  loadCustomPromptTemplates,
  saveCustomPromptTemplate,
  updateCustomPromptTemplate,
} from '@renderer/features/prompt-templates/templates'
import type { PromptTemplate } from '@renderer/features/prompt-templates/templates'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCaffeinateStore } from '@renderer/features/caffeinate/store'
import { useDevDebugConfig } from '@renderer/features/debug/devDebugConfig'
import { usePathPickerRequests } from '@renderer/features/path-picker/usePathPickerRequests'
import { SessionPreviewPane } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import type { PreviewTarget } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { dirtyAiWorkspacePaths } from '@renderer/features/ai-workspace/lib/aiWorkspaceSurfaceCache'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import type { AiWorkspaceSummary } from '@mcp/shared/aiWorkspaceTypes'
// Canonical session listing shape. This was a local copy that DROPPED
// `fileSize` (and `customTitle`) — a concrete instance of the drift the
// shared contract prevents: the palette consumes `SessionInfo[]` straight
// from `window.api.listSessionsForCwd`, which always returns the full shape,
// so the narrower local type was hiding fields rather than reflecting reality.
import type { SessionInfo } from '@shared/types/session'

// CommandPalette — VS Code-style ⌘⇧P command menu.
//
// The palette itself now only owns search / selection / the resume
// sub-mode UI. The command registry lives outside this component
// under feature-owned folders, so adding a feature command no longer
// requires editing the palette implementation itself.

type BuriedPaneInfo = {
  id: string
  label: string
  description: string
  note?: string
  buriedAt: number
}

type PaletteMode =
  | 'commands'
  | 'resume'
  | 'buried'
  | 'kill-buried'
  | 'prompt-template'
  | 'save-prompt-template'
  | 'edit-prompt-template'
  | 'ai-workspace-open'
  | 'ai-workspace-create'
  | 'ai-workspace-clear'

type PromptTemplateForm = {
  id: string | null
  title: string
  body: string
}

// Global "reveal every command" escape hatch. Hard-coded false, moved
// here from App.tsx (#494): issue #249 shipped the per-command override
// mechanism only. A future "show hidden commands" affordance can flip
// this to reveal the full list in one shot.
const SHOW_HIDDEN_COMMANDS = false

export function CommandPalette() {
  const open = useAppStore(state => state.commandPaletteOpen)
  const openPalette = useAppStore(state => state.openCommandPalette)
  const [pendingMenuCommand, setPendingMenuCommand] = useState<{
    id: string
    closeAfterRun: boolean
  } | null>(null)

  useEffect(
    () =>
      window.api.onMenuCommand(commandId => {
        // Native-menu IPC bypasses Radix's DOM focus trap and inert background.
        // Check the same synchronous ownership marker as keyboard, paste, Enter,
        // and dictation before mounting the heavy command implementation. Without
        // this guard a File-menu click could mutate workspace state underneath an
        // unrelated confirmation dialog even though every DOM input path was
        // correctly blocked. When the command palette itself is open it also owns
        // this marker, so menu commands wait instead of competing with its current
        // search/navigation turn.
        if (hasAppInteractionOwner()) return
        // WHY a native menu command temporarily mounts the open implementation:
        // command definitions need live workspace actions, but keeping that entire
        // registry subscribed while the palette is closed made every session delta
        // rebuild an invisible feature. A menu click is rare and intentional, so it
        // may pay the one-time registry cost. useLayoutEffect below runs it and
        // closes before paint, avoiding a palette flash for menu-only execution.
        setPendingMenuCommand({ id: commandId, closeAfterRun: !open })
        if (!open) openPalette()
      }),
    [open, openPalette],
  )

  const clearPendingMenuCommand = useCallback(() => setPendingMenuCommand(null), [])

  // WHY the workspace-heavy component does not exist while closed: returning
  // null at the bottom of the old monolith was too late. Hooks had already read
  // the monolithic workspace context, assembled ~76 command dependencies, and
  // built the registry. This outer gate subscribes to one boolean plus the
  // native bridge; ordinary agent traffic cannot fan into the hidden palette.
  if (!open) return null
  return (
    <OpenCommandPalette
      pendingMenuCommand={pendingMenuCommand}
      onMenuCommandHandled={clearPendingMenuCommand}
    />
  )
}

function OpenCommandPalette({
  pendingMenuCommand,
  onMenuCommandHandled,
}: {
  pendingMenuCommand: { id: string; closeAfterRun: boolean } | null
  onMenuCommandHandled: () => void
}) {
  // #494: the palette used to receive ~76 props whose only purpose was
  // to be reassembled into `commandContext` below. It now sources every
  // value itself — the store actions/flags by selector, workspace via
  // context, caffeinate/dev-debug via their feature stores — so App.tsx
  // stopped being a wiring hub. The `commandContext` SHAPE (ui/flags
  // buckets, types.ts) is deliberately unchanged: command definitions
  // are untouched, and the future provider-enumeration rewrite (#394 §7)
  // rebuilds command CONTENT, not this assembly.
  const workspace = useWorkspaceContext()
  const onClose = useAppStore(state => state.closeCommandPalette)
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()

  const openTileTabsModal = useAppStore(state => state.openTileTabsModal)
  const onTileTabsRequest = useCallback(() => {
    openTileTabsModal(
      workspace.tileTabs?.tabIds ?? (workspace.activeTab ? [workspace.activeTab.id] : []),
    )
  }, [openTileTabsModal, workspace.activeTab, workspace.tileTabs])
  const onReorderTabsRequest = useAppStore(state => state.openReorderTabs)
  const onSettingsRequest = useAppStore(state => state.openSettingsPage)
  const openViewPrompts = useAppStore(state => state.openViewPrompts)
  const openPromptSearch = useAppStore(state => state.openPromptSearch)
  const openAgentActivity = useAppStore(state => state.openAgentActivity)
  const openCloseOldAgents = useAppStore(state => state.openCloseOldAgents)
  const openBulkProviderSwitch = useAppStore(state => state.openBulkProviderSwitch)
  const openRewindPrompt = useAppStore(state => state.openRewindPrompt)
  const openAgentViewModePicker = useAppStore(state => state.openAgentViewModePicker)
  const openUsageModal = useAppStore(state => state.openUsageModal)
  const toggleGitBar = useAppStore(state => state.toggleGitBar)
  const toggleWorktreesBar = useAppStore(state => state.toggleWorktreesBar)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleRenderingDebugMode = useAppStore(state => state.toggleRenderingDebugMode)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const openAgentStatusPanel = useAppStore(state => state.openAgentStatusPanel)
  const closeAgentStatusPanel = useAppStore(state => state.closeAgentStatusPanel)
  const toggleAgentStatusPanel = useAppStore(state => state.toggleAgentStatusPanel)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const toggleRemotePanel = useAppStore(state => state.toggleRemotePanel)
  const toggleGlobalEditor = useAppStore(state => state.toggleGlobalEditor)
  const openTiledDispatchPrompt = useAppStore(state => state.openTiledDispatchPrompt)
  const openDispatchAttach = useAppStore(state => state.openDispatchAttach)
  const openLinkedAgent = useAppStore(state => state.openLinkedAgent)
  const openPinAgents = useAppStore(state => state.openPinAgents)
  const toggleStatusMode = useAppStore(state => state.toggleStatusMode)
  const toggleWorktreeBadges = useAppStore(state => state.toggleWorktreeBadges)
  const toggleUsageHeader = useAppStore(state => state.toggleUsageHeader)
  const cycleUsageHeaderLevel = useAppStore(state => state.cycleUsageHeaderLevel)
  const toggleCaffeinate = useCaffeinateStore(state => state.toggle)
  const caffeinateStatus = useCaffeinateStore(state => state.status)
  const devDebugEnabled = useDevDebugConfig(state => state.enabled)
  const sessionRecordingEnabled = useDevDebugConfig(state => state.sessionRecordingEnabled)
  // File-tree visibility lives on the global-editor store, not on
  // uiShell, because it's editor-scoped state — the rest of the
  // workspace has no concept of "the file tree."
  const fileTreeVisible = useGlobalEditorStore(state => state.fileTreeVisible)
  const toggleFileTreeVisible = useGlobalEditorStore(state => state.toggleFileTreeVisible)
  const editorFullscreen = useGlobalEditorStore(state => state.editorFullscreen)

  const enterDispatchMode = workspace.enterDispatchMode
  const exitDispatchMode = workspace.exitDispatchMode
  const enterGlobalDispatch = useCallback(
    () =>
      workspace.setDispatchScope(workspace.dispatchMode?.scope === 'global' ? 'project' : 'global'),
    [workspace],
  )
  const setDangerousAgentsEnabled = useCallback(
    (enabled: boolean) => setSettings({ dangerousAgentsEnabled: enabled }),
    [setSettings],
  )
  const setAggressiveDebugPersistence = useCallback(
    (enabled: boolean) => setSettings({ aggressiveDebugPersistence: enabled }),
    [setSettings],
  )

  const agentViewMode = settings.agentViewMode
  const commandVisibilityOverrides = settings.commandVisibilityOverrides
  const showHiddenCommands = SHOW_HIDDEN_COMMANDS
  const statusModeEnabled = settings.showStatusMode
  const worktreeBadgesEnabled = settings.showWorktreeBadges
  const usageHeaderEnabled = settings.usageHeaderEnabled
  const usageHeaderLevel = settings.usageHeaderLevel
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const aggressiveDebugPersistenceEnabled = settings.aggressiveDebugPersistence
  const gitBarOpen = useAppStore(state => state.gitBarOpen)
  const worktreesBarOpen = useAppStore(state => state.worktreesBarOpen)
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const renderingDebugMode = useAppStore(state => state.renderingDebugMode)
  const devDebugPanelOpen = useAppStore(state => state.devDebugPanelOpen)
  const agentStatusPanelOpen = useAppStore(state => state.agentStatusPanelOpen)
  const performancePanelOpen = useAppStore(state => state.performancePanelOpen)
  const globalEditorOpen = useAppStore(state => state.globalEditorOpen)
  const caffeinateActive = caffeinateStatus?.active === true
  const caffeinateSupported = caffeinateStatus?.supported !== false
  const dispatchModeEnabled = workspace.dispatchMode !== null
  const globalDispatchEnabled = workspace.dispatchMode?.scope === 'global'

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<PaletteMode>('commands')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [aiWorkspaces, setAiWorkspaces] = useState<AiWorkspaceSummary[]>([])
  const [aiWorkspacesLoading, setAiWorkspacesLoading] = useState(false)
  const [aiWorkspaceError, setAiWorkspaceError] = useState<string | null>(null)
  const [aiWorkspacePending, setAiWorkspacePending] = useState<string | null>(null)
  const [armedAiWorkspaceClearId, setArmedAiWorkspaceClearId] = useState<string | null>(null)
  const [customPromptTemplates, setCustomPromptTemplates] = useState<PromptTemplate[]>([])
  const [promptTemplateForm, setPromptTemplateForm] = useState<PromptTemplateForm>({
    id: null,
    title: '',
    body: '',
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const focusedSessionId = commandTargetSessionId(workspace)
  const focusedMeta = focusedSessionId ? workspace.state.sessions[focusedSessionId] : null
  const focusedCwd = focusedMeta?.cwd ?? null
  const focusedProvider = focusedMeta?.kind ?? DEFAULT_PROVIDER
  // The provider whose sessions the resume picker lists and resumes into.
  // Use the focused pane's ACTUAL provider so an opencode pane resumes
  // opencode, a codex pane codex, etc. The three call sites below used to
  // read `focusedProvider === 'codex' ? 'codex' : 'claude'`, which silently
  // collapsed EVERY non-codex kind — including opencode (a registered
  // provider since phase 7) — to Claude. That made an opencode-focused
  // resume picker list Claude sessions and spawn a Claude pane, even though
  // the picker header already displayed "resume opencode". Terminal / unknown
  // kinds have no resume story, so fall back to the default provider.
  const resumeProvider: AgentProviderKind = isAgentProviderKind(focusedProvider)
    ? focusedProvider
    : DEFAULT_PROVIDER

  const enterResumeMode = useCallback(async () => {
    if (!focusedCwd) return
    setMode('resume')
    setQuery('')
    setSelectedIndex(0)
    setSessionsLoading(true)
    try {
      const list = await window.api.listSessionsForCwd(focusedCwd, 20, resumeProvider)
      setSessions(list)
    } catch {
      setSessions([])
    }
    setSessionsLoading(false)
  }, [focusedCwd, focusedProvider])

  // Buried panes are scoped to the ACTIVE TAB. The natural temptation
  // is to show every buried pane in the workspace ("they're paused
  // work, the user might want any of them") but that mixes contexts:
  // a buried Codex agent from project A appears alongside a buried
  // Claude agent from project B with no surface-level indication
  // they're cross-project. Scoping by sourceTabId matches the rest of
  // the workspace's per-tab discipline and prevents revive-into-wrong-
  // tab footguns (revive places the pane back into the tab the user
  // is currently in, not the tab it was buried from).
  //
  // Buried panes from other tabs are not lost — switching to that tab
  // surfaces them in its palette.
  const activeTabId = workspace.state.activeTabId
  const buried = useMemo<BuriedPaneInfo[]>(
    () =>
      [...workspace.state.buried]
        .filter(entry => entry.sourceTabId === activeTabId)
        .sort((a, b) => b.buriedAt - a.buriedAt)
        .map(entry => {
          const kind = entry.sessionMeta.kind ?? DEFAULT_PROVIDER
          const cwd = entry.sessionMeta.cwd
          const cwdBase = cwd.split('/').filter(Boolean).pop() ?? cwd
          return {
            id: entry.id,
            label: `${kind} · ${cwdBase}`,
            description: `${entry.sourceTabTitle} · ${cwd}`,
            note: entry.note,
            buriedAt: entry.buriedAt,
          }
        }),
    [activeTabId, workspace.state.buried],
  )

  const enterBuriedMode = useCallback(() => {
    setMode('buried')
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const enterKillBuriedMode = useCallback(() => {
    setMode('kill-buried')
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const enterPromptTemplateMode = useCallback(() => {
    setCustomPromptTemplates(loadCustomPromptTemplates())
    setMode('prompt-template')
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const enterSavePromptTemplateMode = useCallback(() => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    const draft = workspace.getRuntime(sessionId).draftInput.trim()
    if (!draft) return
    setPromptTemplateForm({ id: null, title: '', body: draft })
    setMode('save-prompt-template')
    setQuery('')
    setSelectedIndex(0)
  }, [workspace])

  const enterEditPromptTemplateMode = useCallback((template: PromptTemplate) => {
    if (template.scope !== 'custom') return
    setPromptTemplateForm({
      id: template.id,
      title: template.title,
      body: template.body,
    })
    setMode('edit-prompt-template')
    setQuery(template.title)
    setSelectedIndex(0)
  }, [])

  const loadAiWorkspaces = useCallback(async () => {
    setAiWorkspacesLoading(true)
    setAiWorkspaceError(null)
    try {
      setAiWorkspaces(await window.api.aiWorkspaceList())
    } catch (error) {
      setAiWorkspaces([])
      setAiWorkspaceError(
        `Could not load AI Workspaces: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setAiWorkspacesLoading(false)
    }
  }, [])

  const enterAiWorkspaceOpenMode = useCallback(() => {
    setMode('ai-workspace-open')
    setQuery('')
    setSelectedIndex(0)
    setArmedAiWorkspaceClearId(null)
    void loadAiWorkspaces()
  }, [loadAiWorkspaces])

  const enterAiWorkspaceCreateMode = useCallback(() => {
    setMode('ai-workspace-create')
    setQuery('')
    setSelectedIndex(0)
    setAiWorkspaceError(null)
    setArmedAiWorkspaceClearId(null)
  }, [])

  const enterAiWorkspaceClearMode = useCallback(() => {
    setMode('ai-workspace-clear')
    setQuery('')
    setSelectedIndex(0)
    setArmedAiWorkspaceClearId(null)
    void loadAiWorkspaces()
  }, [loadAiWorkspaces])

  const commandContext = useMemo<CommandContext>(
    () => ({
      workspace,
      ui: {
        openNewTabPicker: onNewTabRequest,
        openResumePicker: onResumeRequest,
        openTileTabs: onTileTabsRequest,
        openReorderTabs: onReorderTabsRequest,
        openSettings: onSettingsRequest,
        openViewPrompts,
        openPromptSearch,
        openAgentActivity,
        openCloseOldAgents,
        openBulkProviderSwitch,
        openRewindPrompt,
        openAgentViewModePicker,
        openUsageModal,
        toggleGitBar,
        toggleWorktreesBar,
        toggleDebugPanel,
        toggleFeedDebugPanel,
        toggleProxyDebugPanel,
        toggleHtmlDebugPanel,
        toggleRenderingDebugMode,
        toggleDevDebugPanel,
        openAgentStatusPanel,
        closeAgentStatusPanel,
        toggleAgentStatusPanel,
        togglePerformancePanel,
        toggleRemotePanel,
        toggleCaffeinate,
        toggleGlobalEditor,
        toggleFileTreeVisible,
        enterDispatchMode,
        enterGlobalDispatch,
        exitDispatchMode,
        openTiledDispatchPrompt,
        openDispatchAttach,
        openLinkedAgent,
        openPinAgents,
        toggleStatusMode,
        toggleWorktreeBadges,
        toggleUsageHeader,
        cycleUsageHeaderLevel,
        setDangerousAgentsEnabled,
        setAggressiveDebugPersistence,
        enterResumeMode,
        enterBuriedMode,
        enterKillBuriedMode,
        enterPromptTemplateMode,
        enterSavePromptTemplateMode,
        enterAiWorkspaceOpenMode,
        enterAiWorkspaceCreateMode,
        enterAiWorkspaceClearMode,
        closePalette: onClose,
      },
      flags: {
        statusModeEnabled,
        worktreeBadgesEnabled,
        usageHeaderEnabled,
        usageHeaderLevel,
        dangerousAgentsEnabled,
        aggressiveDebugPersistenceEnabled,
        gitBarOpen,
        worktreesBarOpen,
        debugPanelOpen,
        feedDebugPanelOpen,
        proxyDebugPanelOpen,
        htmlDebugPanelOpen,
        renderingDebugMode,
        devDebugEnabled,
        sessionRecordingEnabled,
        devDebugPanelOpen,
        agentStatusPanelOpen,
        performancePanelOpen,
        caffeinateActive,
        caffeinateSupported,
        globalEditorOpen,
        focusedCwd,
        fileTreeVisible,
        editorFullscreen,
        dispatchModeEnabled,
        globalDispatchEnabled,
        agentViewMode,
        commandVisibilityOverrides,
        showHiddenCommands,
      },
    }),
    [
      workspace,
      onNewTabRequest,
      onResumeRequest,
      onTileTabsRequest,
      onReorderTabsRequest,
      onSettingsRequest,
      openViewPrompts,
      openPromptSearch,
      openAgentActivity,
      openCloseOldAgents,
      openBulkProviderSwitch,
      openRewindPrompt,
      openAgentViewModePicker,
      openUsageModal,
      toggleGitBar,
      toggleWorktreesBar,
      toggleDebugPanel,
      toggleFeedDebugPanel,
      toggleProxyDebugPanel,
      toggleHtmlDebugPanel,
      toggleRenderingDebugMode,
      toggleDevDebugPanel,
      openAgentStatusPanel,
      closeAgentStatusPanel,
      toggleAgentStatusPanel,
      togglePerformancePanel,
      toggleRemotePanel,
      toggleCaffeinate,
      toggleGlobalEditor,
      toggleFileTreeVisible,
      enterDispatchMode,
      enterGlobalDispatch,
      exitDispatchMode,
      openTiledDispatchPrompt,
      openDispatchAttach,
      openLinkedAgent,
      openPinAgents,
      toggleStatusMode,
      toggleWorktreeBadges,
      toggleUsageHeader,
      cycleUsageHeaderLevel,
      setDangerousAgentsEnabled,
      setAggressiveDebugPersistence,
      enterResumeMode,
      enterBuriedMode,
      enterKillBuriedMode,
      enterPromptTemplateMode,
      enterSavePromptTemplateMode,
      enterAiWorkspaceOpenMode,
      enterAiWorkspaceCreateMode,
      enterAiWorkspaceClearMode,
      onClose,
      statusModeEnabled,
      worktreeBadgesEnabled,
      usageHeaderEnabled,
      usageHeaderLevel,
      dangerousAgentsEnabled,
      aggressiveDebugPersistenceEnabled,
      gitBarOpen,
      worktreesBarOpen,
      debugPanelOpen,
      feedDebugPanelOpen,
      proxyDebugPanelOpen,
      htmlDebugPanelOpen,
      renderingDebugMode,
      devDebugEnabled,
      sessionRecordingEnabled,
      devDebugPanelOpen,
      agentStatusPanelOpen,
      performancePanelOpen,
      caffeinateActive,
      caffeinateSupported,
      globalEditorOpen,
      focusedCwd,
      fileTreeVisible,
      editorFullscreen,
      dispatchModeEnabled,
      globalDispatchEnabled,
      agentViewMode,
      commandVisibilityOverrides,
      showHiddenCommands,
    ],
  )

  const commands = useMemo(() => buildCommandRegistry(commandContext), [commandContext])

  const promptTemplates = useMemo(
    () => allPromptTemplates(customPromptTemplates),
    [customPromptTemplates],
  )

  const queryText = query.trim()
  const filteredSessions = useMemo(
    () =>
      queryText
        ? sessions.filter(
            s =>
              fuzzyMatch(s.summary, queryText) ||
              fuzzyMatch(s.firstPrompt ?? '', queryText) ||
              fuzzyMatch(s.gitBranch ?? '', queryText),
          )
        : sessions,
    [sessions, queryText],
  )
  const filteredBuried = useMemo(
    () =>
      queryText
        ? buried.filter(
            item =>
              fuzzyMatch(item.label, queryText) ||
              fuzzyMatch(item.description, queryText) ||
              fuzzyMatch(item.note ?? '', queryText),
          )
        : buried,
    [buried, queryText],
  )
  const filteredPromptTemplates = useMemo(
    () =>
      queryText
        ? promptTemplates.filter(
            template =>
              fuzzyMatch(template.title, queryText) ||
              fuzzyMatch(template.description, queryText) ||
              fuzzyMatch(template.body, queryText),
          )
        : promptTemplates,
    [promptTemplates, queryText],
  )
  const filteredAiWorkspaces = useMemo(
    () =>
      queryText
        ? aiWorkspaces.filter(
            workspace =>
              fuzzyMatch(workspace.name, queryText) ||
              fuzzyMatch(workspace.description ?? '', queryText) ||
              fuzzyMatch(workspace.workspaceId, queryText),
          )
        : aiWorkspaces,
    [aiWorkspaces, queryText],
  )
  // Snapshot recent-command history once per mounted palette. The open-only
  // component is destroyed on close, so an empty dependency list now expresses
  // the old "once per open" lifetime directly without retaining the expensive
  // command registry between opens.
  const historyScoreMap = useMemo(() => buildHistoryScoreMap(loadRecentHistory()), [])
  // rankCommands owns all ordering now (tier-first text match, with
  // history as a same-tier tiebreaker; empty query returns registry
  // order unchanged). Everything downstream of this is index-based and
  // unaware that ordering changed, so this is the only line that needs
  // to swap from the old boolean filter to the ranked list.
  const filteredCommands = useMemo(
    () => rankCommands(commands, queryText, historyScoreMap),
    [commands, queryText, historyScoreMap],
  )
  const directAgentTarget = useMemo(
    () => resolveAgentPaneLabel(workspace.state, queryText, workspace.tileTabs),
    [queryText, workspace.state, workspace.tileTabs],
  )
  const directAgentCommand = useMemo(
    () =>
      directAgentTarget
        ? buildAgentIndexCommand(directAgentTarget, workspace.focusAgentByPaneLabel)
        : null,
    [directAgentTarget, workspace.focusAgentByPaneLabel],
  )
  // The exact coordinate result is deliberately row zero. It is not part of
  // fuzzy command ranking and must win Enter even if a future command happens
  // to contain "A2" in its title or keywords.
  const paletteCommands = useMemo(
    () => (directAgentCommand ? [directAgentCommand, ...filteredCommands] : filteredCommands),
    [directAgentCommand, filteredCommands],
  )

  const filteredLength =
    mode === 'resume'
      ? filteredSessions.length
      : mode === 'buried' || mode === 'kill-buried'
        ? filteredBuried.length
        : mode === 'prompt-template'
          ? filteredPromptTemplates.length
          : mode === 'ai-workspace-open' || mode === 'ai-workspace-clear'
            ? filteredAiWorkspaces.length
            : mode === 'commands'
              ? paletteCommands.length
              : 0

  const selectedCommand = useMemo(() => {
    if (mode !== 'commands') return null
    return paletteCommands[selectedIndex] ?? null
  }, [mode, paletteCommands, selectedIndex])

  useEffect(() => {
    setQuery('')
    setSelectedIndex(0)
    setMode('commands')
    setSessions([])
    setSessionsLoading(false)
    setAiWorkspaces([])
    setAiWorkspacesLoading(false)
    setAiWorkspaceError(null)
    setAiWorkspacePending(null)
    setArmedAiWorkspaceClearId(null)
    setPromptTemplateForm({ id: null, title: '', body: '' })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, filteredLength - 1)))
  }, [filteredLength])

  useEffect(() => {
    // WHY confirmation is tied to the current row/query: a destructive second
    // Enter should never apply to a workspace that became selected only because
    // the user kept navigating or filtered the list after arming another row.
    setArmedAiWorkspaceClearId(null)
  }, [mode, query, selectedIndex])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex]
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const executeCommand = useCallback(
    (command: ResolvedCommand) => {
      // Record the use BEFORE running. This is the single funnel every
      // command execution passes through (keyboard Enter and click both
      // route here), so it's the one correct place to update history.
      // recordCommandUse never throws, so it can't block command.run.
      // Agent coordinates are transient workspace destinations, not reusable
      // registry commands. Recording `agent-index:<sessionId>` would fill the
      // recent-command history with launch-local ids that can never rank a
      // future palette open, while crowding out real commands the user repeats.
      if (!isAgentIndexCommand(command)) recordCommandUse(command.id)
      if (command.keepPaletteOpen) {
        void command.run(commandContext)
        return
      }
      onClose()
      void command.run(commandContext)
    },
    [commandContext, onClose],
  )

  // Native menu → command dispatch (issue #148).
  //
  // The macOS File menu lives in main, but its actions are renderer commands
  // that need the live CommandContext (workspace store + UI callbacks) to run.
  // Main can't run them; it only knows the command's string id. So main emits
  // the id over `menu:command` and we resolve + run it here, where `commands`
  // (the resolved registry) and `commandContext` are in scope.
  //
  // The lightweight outer bridge owns the always-on IPC listener. It mounts
  // this implementation only long enough to resolve against the SAME registry
  // the visible palette uses, so native and palette execution cannot drift.
  useLayoutEffect(() => {
    if (!pendingMenuCommand) return
    const command = commands.find(candidate => candidate.id === pendingMenuCommand.id)
    if (command) void command.run(commandContext)
    onMenuCommandHandled()
    if (pendingMenuCommand.closeAfterRun) onClose()
  }, [commandContext, commands, onClose, onMenuCommandHandled, pendingMenuCommand])

  const executeResume = useCallback(
    (session: SessionInfo) => {
      onClose()
      if (!focusedCwd) return
      void workspace.replaceSession(focusedCwd, {
        resumeSessionId: session.sessionId,
        kind: resumeProvider,
      })
    },
    [onClose, focusedCwd, focusedProvider, workspace],
  )

  const executeBuried = useCallback(
    (item: BuriedPaneInfo) => {
      onClose()
      void workspace.reviveBuried(item.id)
    },
    [onClose, workspace],
  )

  const executeKillBuried = useCallback(
    (item: BuriedPaneInfo) => {
      const remainingCount = filteredBuried.filter(candidate => candidate.id !== item.id).length
      void workspace.killBuried(item.id).then(() => {
        if (remainingCount === 0) onClose()
        else setSelectedIndex(i => Math.max(0, Math.min(i, remainingCount - 1)))
      })
    },
    [filteredBuried, onClose, workspace],
  )

  const executePromptTemplate = useCallback(
    async (template: PromptTemplate) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return

      try {
        const body = template.buildBody
          ? await template.buildBody({ workspace, sessionId })
          : template.body
        // Template insertion deliberately stops at the draft boundary.
        // The user's next action is still visible and editable in the
        // composer; nothing is sent to Claude/Codex until they press
        // Enter themselves. This mirrors rewind-to-prompt's "prefill,
        // don't replay" contract.
        workspace.setDraftInput(sessionId, body)
        workspace.showPaneToast(sessionId, `Inserted template: ${template.title}`)
        onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        workspace.showPaneToast(sessionId, `Template failed: ${message}`)
      }
    },
    [onClose, workspace],
  )

  const refreshCustomPromptTemplates = useCallback(() => {
    setCustomPromptTemplates(loadCustomPromptTemplates())
  }, [])

  const savePromptTemplateForm = useCallback(() => {
    const title = promptTemplateForm.title.trim()
    const body = promptTemplateForm.body.trim()
    if (!title || !body) return

    const sessionId = commandTargetSessionId(workspace)
    const template = promptTemplateForm.id
      ? updateCustomPromptTemplate(promptTemplateForm.id, title, body)
      : saveCustomPromptTemplate(title, body)
    if (!template) return

    refreshCustomPromptTemplates()
    setPromptTemplateForm({ id: null, title: '', body: '' })
    setMode('prompt-template')
    setQuery('')
    setSelectedIndex(0)
    if (sessionId) {
      workspace.showPaneToast(
        sessionId,
        promptTemplateForm.id
          ? `Updated prompt template: ${template.title}`
          : `Saved prompt template: ${template.title}`,
      )
    }
  }, [promptTemplateForm, refreshCustomPromptTemplates, workspace])

  const openAiWorkspace = useCallback(
    (workspaceId: string) => {
      useGlobalEditorStore.getState().openAiWorkspace(workspaceId)
      if (!globalEditorOpen) toggleGlobalEditor()
      onClose()
    },
    [globalEditorOpen, onClose, toggleGlobalEditor],
  )

  const createAiWorkspace = useCallback(async () => {
    const name = query.trim()
    if (!name || aiWorkspacePending) return
    setAiWorkspacePending('create')
    setAiWorkspaceError(null)
    try {
      const workspace = await window.api.aiWorkspaceCreate({ name })
      openAiWorkspace(workspace.workspaceId)
    } catch (error) {
      setAiWorkspaceError(
        `Could not create AI Workspace: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setAiWorkspacePending(null)
    }
  }, [aiWorkspacePending, openAiWorkspace, query])

  const clearAiWorkspace = useCallback(
    async (summary: AiWorkspaceSummary) => {
      if (aiWorkspacePending) return
      if (armedAiWorkspaceClearId !== summary.workspaceId) {
        setArmedAiWorkspaceClearId(summary.workspaceId)
        return
      }
      const dirtyPaths = dirtyAiWorkspacePaths(summary.workspaceId)
      if (dirtyPaths.length > 0) {
        const message = `Save or close ${dirtyPaths.length} unsaved AI Workspace ${dirtyPaths.length === 1 ? 'file' : 'files'} before clearing it.`
        setAiWorkspaceError(message)
        const sessionId = commandTargetSessionId(workspace)
        if (sessionId) {
          workspace.showPaneToast(sessionId, message)
        }
        setArmedAiWorkspaceClearId(null)
        return
      }
      setAiWorkspacePending(summary.workspaceId)
      setAiWorkspaceError(null)
      try {
        await window.api.aiWorkspaceClear(summary.workspaceId)
        await loadAiWorkspaces()
        setSelectedIndex(0)
        setArmedAiWorkspaceClearId(null)
      } catch (error) {
        setAiWorkspaceError(
          `Could not clear AI Workspace: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        setAiWorkspacePending(null)
      }
    },
    [aiWorkspacePending, armedAiWorkspaceClearId, loadAiWorkspaces, workspace],
  )

  const deletePromptTemplate = useCallback(
    (template: PromptTemplate) => {
      if (template.scope !== 'custom') return
      deleteCustomPromptTemplate(template.id)
      refreshCustomPromptTemplates()
      setSelectedIndex(i => Math.max(0, Math.min(i, customPromptTemplates.length - 2)))
    },
    [customPromptTemplates.length, refreshCustomPromptTemplates],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, filteredLength - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (aiWorkspacePending) return
        if (mode === 'save-prompt-template' || mode === 'edit-prompt-template') {
          savePromptTemplateForm()
        } else if (mode === 'ai-workspace-create') {
          void createAiWorkspace()
        } else if (mode === 'ai-workspace-open') {
          const workspace = filteredAiWorkspaces[selectedIndex]
          if (workspace) openAiWorkspace(workspace.workspaceId)
        } else if (mode === 'ai-workspace-clear') {
          const workspace = filteredAiWorkspaces[selectedIndex]
          if (workspace) void clearAiWorkspace(workspace)
        } else if (mode === 'resume') {
          const session = filteredSessions[selectedIndex]
          if (session) executeResume(session)
        } else if (mode === 'buried') {
          const item = filteredBuried[selectedIndex]
          if (item) executeBuried(item)
        } else if (mode === 'kill-buried') {
          const item = filteredBuried[selectedIndex]
          if (item) executeKillBuried(item)
        } else if (mode === 'prompt-template') {
          const template = filteredPromptTemplates[selectedIndex]
          if (template) void executePromptTemplate(template)
        } else {
          const command = paletteCommands[selectedIndex]
          if (command) executeCommand(command)
        }
      }
    },
    [
      mode,
      aiWorkspacePending,
      filteredLength,
      filteredBuried,
      paletteCommands,
      filteredAiWorkspaces,
      filteredPromptTemplates,
      filteredSessions,
      selectedIndex,
      executeBuried,
      executeCommand,
      executeKillBuried,
      executePromptTemplate,
      executeResume,
      createAiWorkspace,
      clearAiWorkspace,
      openAiWorkspace,
      savePromptTemplateForm,
    ],
  )

  // In resume mode, the conversation preview pane mirrors the
  // highlighted row. `selectedIndex` is driven by both keyboard (↑/↓)
  // and hover (onMouseEnter on each row), so the preview follows
  // either. A session's own cwd wins over the focused pane's cwd
  // because the list can surface sessions from the focused project's
  // history — same-cwd in practice, but be exact.
  const resumePreviewTarget: PreviewTarget | null = (() => {
    if (mode !== 'resume') return null
    // `filteredSessions` is the resume-mode list `selectedIndex` indexes
    // into (same array the keyboard handler and the rendered rows use).
    // An earlier draft of this block referenced a `filtered` variable
    // that a concurrent command-palette refactor had already renamed —
    // the two changes merged cleanly as text but left this reference
    // dangling. `filteredSessions` is typed `SessionInfo[]`, so the
    // cast is belt-and-suspenders against noUncheckedIndexedAccess.
    const session = filteredSessions[selectedIndex] as SessionInfo | undefined
    if (!session) return null
    const cwd = session.cwd ?? focusedCwd
    if (!cwd) return null
    return {
      kind: resumeProvider,
      cwd,
      providerSessionId: session.sessionId,
    }
  })()

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className={`
          top-[12vh] translate-y-0 flex flex-col p-0
          bg-popover-bg border border-popover-border
          shadow-[0_16px_48px_var(--theme-shadow-color)]
          overflow-hidden
          ${
            mode === 'resume'
              ? 'w-[min(1180px,95vw)] max-h-[80vh]'
              : 'w-[min(900px,92vw)] max-h-[60vh]'
          }
        `}
        onEscapeKeyDown={event => {
          // The palette has nested navigation modes. Escape first backs out
          // of a mode; only the top-level command list dismisses the Dialog.
          // Preventing Radix's close for those inner transitions preserves the
          // established keyboard model without reimplementing global Escape.
          if (mode === 'commands') return
          event.preventDefault()
          if (mode === 'edit-prompt-template') {
            setMode('prompt-template')
          } else {
            setMode('commands')
          }
          setPromptTemplateForm({ id: null, title: '', body: '' })
          setQuery('')
          setSelectedIndex(0)
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search application commands and related session workflows.
        </DialogDescription>
        <div className="flex-shrink-0 border-b border-border px-3 py-2 flex items-center gap-2">
          {mode === 'resume' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              resume {focusedProvider} &rsaquo;
            </span>
          )}
          {mode === 'buried' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              revive &rsaquo;
            </span>
          )}
          {mode === 'kill-buried' && (
            <span className="text-danger text-[11px] flex-shrink-0 select-none">
              kill buried &rsaquo;
            </span>
          )}
          {mode === 'prompt-template' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              template &rsaquo;
            </span>
          )}
          {mode === 'save-prompt-template' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              save template &rsaquo;
            </span>
          )}
          {mode === 'edit-prompt-template' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              edit template &rsaquo;
            </span>
          )}
          {mode === 'ai-workspace-open' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              open AI workspace &rsaquo;
            </span>
          )}
          {mode === 'ai-workspace-create' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              create AI workspace &rsaquo;
            </span>
          )}
          {mode === 'ai-workspace-clear' && (
            <span className="text-danger text-[11px] flex-shrink-0 select-none">
              clear AI workspace &rsaquo;
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            className="
              flex-1 bg-transparent
              text-ink text-[13px] font-code
              outline-none
              placeholder:text-muted
            "
            placeholder={
              mode === 'save-prompt-template' || mode === 'edit-prompt-template'
                ? 'Template name…'
                : mode === 'ai-workspace-create'
                  ? 'Workspace name…'
                  : mode === 'resume'
                    ? 'Search sessions…'
                    : mode === 'ai-workspace-open' || mode === 'ai-workspace-clear'
                      ? 'Search AI Workspaces…'
                      : mode === 'buried' || mode === 'kill-buried'
                        ? 'Search buried panes…'
                        : mode === 'prompt-template'
                          ? 'Search prompt templates…'
                          : 'Type a command…'
            }
            value={
              mode === 'save-prompt-template' || mode === 'edit-prompt-template'
                ? promptTemplateForm.title
                : query
            }
            onChange={e => {
              if (mode === 'save-prompt-template' || mode === 'edit-prompt-template') {
                setPromptTemplateForm(form => ({
                  ...form,
                  title: e.target.value,
                }))
              } else {
                setQuery(e.target.value)
              }
              setSelectedIndex(0)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            ref={listRef}
            className={`
              min-h-0 py-1
              ${
                mode === 'commands'
                  ? 'flex-1 min-w-0 overflow-y-auto md:basis-[70%] md:border-r md:border-border'
                  : mode === 'resume'
                    ? 'flex-1 min-w-0 overflow-y-auto md:flex-none md:w-[42%] md:border-r md:border-border'
                    : 'flex-1 overflow-y-auto'
              }
            `}
          >
            {(mode === 'save-prompt-template' || mode === 'edit-prompt-template') && (
              <div className="px-3 py-3 space-y-3">
                <textarea
                  className="
                  h-44 w-full resize-none border border-border bg-canvas
                  px-2 py-2 text-[12px] text-ink font-code outline-none
                  placeholder:text-muted focus:border-accent
                "
                  value={promptTemplateForm.body}
                  onChange={e => {
                    setPromptTemplateForm(form => ({
                      ...form,
                      body: e.target.value,
                    }))
                  }}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      savePromptTemplateForm()
                    }
                  }}
                  spellCheck={false}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="border border-control-border bg-control-hover-bg px-2 py-1 text-[11px] text-muted hover:text-ink"
                    onClick={() => {
                      setPromptTemplateForm({ id: null, title: '', body: '' })
                      setMode(mode === 'edit-prompt-template' ? 'prompt-template' : 'commands')
                      setQuery('')
                      setSelectedIndex(0)
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="border border-accent bg-accent px-2 py-1 text-[11px] text-accent-fg disabled:opacity-40"
                    disabled={!promptTemplateForm.title.trim() || !promptTemplateForm.body.trim()}
                    onClick={savePromptTemplateForm}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}

            {mode === 'commands' &&
              (paletteCommands.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">
                  No matching commands
                </div>
              ) : (
                paletteCommands.map((command, i) => (
                  <div
                    key={command.id}
                    className={`
                    flex items-center justify-between
                    px-3 py-1.5
                    cursor-pointer
                    text-[13px] font-code
                    ${
                      i === selectedIndex
                        ? 'bg-row-selected-bg text-row-selected-fg'
                        : 'text-ink-dim hover:bg-row-hover-bg'
                    }
                  `}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => executeCommand(command)}
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <span>{command.title}</span>
                      {command.state && (
                        <span
                          className={
                            command.state.tone === 'danger'
                              ? 'rounded border border-danger-border bg-danger-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger'
                              : command.state.tone === 'accent'
                                ? 'rounded border border-accent/30 bg-row-selected-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent'
                                : 'rounded border border-panel-border bg-panel-elevated-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted'
                          }
                        >
                          {command.state.label}
                        </span>
                      )}
                    </div>
                    {command.shortcut && (
                      <span className="ml-3 flex-shrink-0 text-[11px] text-muted">
                        {command.shortcut}
                      </span>
                    )}
                  </div>
                ))
              ))}

            {mode === 'resume' &&
              (sessionsLoading ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">
                  Loading sessions…
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">
                  No matching sessions
                </div>
              ) : (
                filteredSessions.map((session, i) => (
                  <div
                    key={session.sessionId}
                    className={`
                    px-3 py-2
                    cursor-pointer
                    border-b border-border last:border-b-0
                    ${
                      i === selectedIndex
                        ? 'bg-row-selected-bg text-row-selected-fg'
                        : 'text-ink-dim hover:bg-row-hover-bg'
                    }
                  `}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => executeResume(session)}
                  >
                    <div className="text-[12px] truncate">
                      {session.summary || session.firstPrompt || session.sessionId}
                    </div>
                    <div className="text-[10px] text-muted mt-0.5 truncate">
                      {session.gitBranch ? `${session.gitBranch} · ` : ''}
                      {session.cwd ?? focusedCwd ?? ''}
                    </div>
                  </div>
                ))
              ))}

            {(mode === 'ai-workspace-open' || mode === 'ai-workspace-clear') && (
              <>
                {aiWorkspaceError ? (
                  <div
                    role="alert"
                    className="mx-2 my-1 border border-danger/40 bg-danger/10 px-2 py-2 text-[11px] text-danger"
                  >
                    {aiWorkspaceError}
                  </div>
                ) : null}
                {aiWorkspacesLoading ? (
                  <div className="px-3 py-4 text-muted text-[12px] text-center">
                    Loading AI Workspaces…
                  </div>
                ) : filteredAiWorkspaces.length === 0 ? (
                  <div className="px-3 py-4 text-muted text-[12px] text-center">
                    {aiWorkspaceError ? 'Try opening this command again.' : 'No AI Workspaces'}
                  </div>
                ) : (
                  filteredAiWorkspaces.map((workspace, i) => {
                    const clearArmed = armedAiWorkspaceClearId === workspace.workspaceId
                    const pending = aiWorkspacePending === workspace.workspaceId
                    return (
                      <button
                        type="button"
                        key={workspace.workspaceId}
                        disabled={aiWorkspacePending !== null}
                        className={`
                          block w-full border-b border-border px-3 py-2 text-left last:border-b-0
                          disabled:cursor-wait disabled:opacity-60
                          ${
                            i === selectedIndex
                              ? mode === 'ai-workspace-clear'
                                ? 'bg-row-danger-selected-bg text-row-selected-fg'
                                : 'bg-row-selected-bg text-row-selected-fg'
                              : 'text-ink-dim hover:bg-row-hover-bg'
                          }
                        `}
                        onMouseEnter={() => setSelectedIndex(i)}
                        onClick={() => {
                          if (mode === 'ai-workspace-clear') void clearAiWorkspace(workspace)
                          else openAiWorkspace(workspace.workspaceId)
                        }}
                      >
                        <div className="text-[12px] truncate">{workspace.name}</div>
                        <div className="text-[10px] text-muted mt-0.5 truncate">
                          {pending
                            ? 'Clearing…'
                            : clearArmed
                              ? 'Press Enter or click again to confirm metadata deletion'
                              : `${workspace.fileCount} files${
                                  workspace.staleCount > 0 ? ` · ${workspace.staleCount} stale` : ''
                                }${workspace.description ? ` · ${workspace.description}` : ''}`}
                        </div>
                      </button>
                    )
                  })
                )}
              </>
            )}

            {mode === 'ai-workspace-create' && (
              <div className="px-3 py-3">
                {aiWorkspaceError ? (
                  <div
                    role="alert"
                    className="mb-3 border border-danger/40 bg-danger/10 px-2 py-2 text-[11px] text-danger"
                  >
                    {aiWorkspaceError}
                  </div>
                ) : null}
                <div className="mb-3 text-[12px] text-muted">
                  {aiWorkspacePending === 'create'
                    ? 'Creating AI Workspace…'
                    : 'Press Enter to create and open the named AI Workspace.'}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="border border-control-border bg-control-hover-bg px-2 py-1 text-[11px] text-muted hover:text-ink"
                    onClick={() => {
                      setMode('commands')
                      setQuery('')
                      setSelectedIndex(0)
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="border border-accent bg-accent px-2 py-1 text-[11px] text-accent-fg disabled:opacity-40"
                    disabled={!query.trim() || aiWorkspacePending !== null}
                    onClick={() => void createAiWorkspace()}
                  >
                    {aiWorkspacePending === 'create' ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </div>
            )}

            {mode === 'buried' &&
              (filteredBuried.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">No buried panes</div>
              ) : (
                filteredBuried.map((item, i) => (
                  <div
                    key={item.id}
                    className={`
                    px-3 py-2
                    cursor-pointer
                    border-b border-border last:border-b-0
                    ${
                      i === selectedIndex
                        ? 'bg-row-selected-bg text-row-selected-fg'
                        : 'text-ink-dim hover:bg-row-hover-bg'
                    }
                  `}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => executeBuried(item)}
                  >
                    <div className="text-[12px] truncate">{item.label}</div>
                    {item.note && (
                      <div className="text-[11px] text-ink mt-0.5 truncate">{item.note}</div>
                    )}
                    <div className="text-[10px] text-muted mt-0.5 truncate">{item.description}</div>
                  </div>
                ))
              ))}

            {mode === 'kill-buried' &&
              (filteredBuried.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">No buried panes</div>
              ) : (
                filteredBuried.map((item, i) => (
                  <div
                    key={item.id}
                    className={`
                    px-3 py-2
                    cursor-pointer
                    border-b border-border last:border-b-0
                    ${
                      i === selectedIndex
                        ? 'bg-row-danger-selected-bg text-row-selected-fg'
                        : 'text-ink-dim hover:bg-row-hover-bg'
                    }
                  `}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => executeKillBuried(item)}
                  >
                    <div className="text-[12px] truncate">{item.label}</div>
                    {item.note && (
                      <div className="text-[11px] text-ink mt-0.5 truncate">{item.note}</div>
                    )}
                    <div className="text-[10px] text-muted mt-0.5 truncate">{item.description}</div>
                  </div>
                ))
              ))}

            {mode === 'prompt-template' &&
              (filteredPromptTemplates.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">
                  No matching templates
                </div>
              ) : (
                filteredPromptTemplates.map((template, i) => (
                  <div
                    key={template.id}
                    className={`
                    px-3 py-2
                    cursor-pointer
                    border-b border-border last:border-b-0
                    ${
                      i === selectedIndex
                        ? 'bg-row-selected-bg text-row-selected-fg'
                        : 'text-ink-dim hover:bg-row-hover-bg'
                    }
                  `}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => void executePromptTemplate(template)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="min-w-0 flex-1 text-[12px] truncate">{template.title}</div>
                      {template.scope === 'custom' && (
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <button
                            type="button"
                            className="border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                            onClick={e => {
                              e.stopPropagation()
                              enterEditPromptTemplateMode(template)
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="border border-danger-border bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger hover:text-danger"
                            onClick={e => {
                              e.stopPropagation()
                              deletePromptTemplate(template)
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                      <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
                        {template.scope}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted mt-0.5 truncate">
                      {template.description}
                    </div>
                  </div>
                ))
              ))}
          </div>

          {mode === 'commands' && <CommandDescriptionPanel command={selectedCommand} />}

          {/* Resume mode — conversation preview for the highlighted
              session, rendered with the real feed rows. Hidden below
              md (same breakpoint policy as the command description
              panel) so the narrow layout stays list-only. */}
          {mode === 'resume' && (
            <aside
              role="region"
              aria-label="Session preview"
              className="hidden md:block md:flex-1 md:min-w-0 min-h-0"
            >
              <SessionPreviewPane target={resumePreviewTarget} />
            </aside>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const COMMAND_DESCRIPTION_COMPONENTS: import('react-markdown').Options['components'] = {
  p: ({ children }) => (
    <p className="mb-2 text-[11px] leading-[1.55] text-ink-dim last:mb-0">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  a: SafeMarkdownLink,
}

const CommandDescriptionPanel = memo(function CommandDescriptionPanel({
  command,
}: {
  command: ResolvedCommand | null
}) {
  if (!command) {
    return (
      <aside
        role="region"
        aria-label="Command details"
        className="hidden basis-[30%] min-w-[220px] bg-canvas px-4 py-4 text-[12px] text-muted md:block"
      >
        Select a command to see what it does.
      </aside>
    )
  }

  return (
    <aside
      role="region"
      aria-label="Command details"
      className="hidden basis-[30%] min-w-[220px] overflow-y-auto bg-canvas px-4 py-4 md:block"
    >
      <div className="mb-3 border-b border-border pb-3">
        <div className="text-[13px] text-ink">{command.title}</div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
          {command.shortcut && <span>{command.shortcut}</span>}
          {command.state && (
            <span
              className={
                command.state.tone === 'danger'
                  ? 'border border-danger-border bg-danger-soft px-1.5 py-0.5 uppercase tracking-wider text-danger'
                  : command.state.tone === 'accent'
                    ? 'border border-accent/30 bg-row-selected-bg px-1.5 py-0.5 uppercase tracking-wider text-accent'
                    : 'border border-panel-border bg-panel-elevated-bg px-1.5 py-0.5 uppercase tracking-wider text-muted'
              }
            >
              {command.state.label}
            </span>
          )}
        </div>
      </div>
      <div>
        <ReactMarkdown components={COMMAND_DESCRIPTION_COMPONENTS}>
          {command.description}
        </ReactMarkdown>
      </div>
    </aside>
  )
})
