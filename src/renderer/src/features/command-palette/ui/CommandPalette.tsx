import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { buildCommandRegistry } from '@renderer/features/command-palette/registry'
import {
  dispatchCommand,
  dispatchResolvedRow,
} from '@renderer/features/command-palette/executeCommand'
import {
  buildAgentIndexCommand,
  isAgentIndexCommand,
  parseAgentIndexPaletteQuery,
} from '@renderer/features/command-palette/lib/agentIndexCommand'
import {
  buildHistoryScoreMap,
  loadRecentHistory,
} from '@renderer/features/command-palette/lib/recentCommandHistory'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { CommandSortControl } from '@renderer/features/command-palette/ui/CommandSortControl'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'
import {
  rankPaletteRows,
  type CommandPaletteRow,
} from '@renderer/features/command-palette/lib/rankPaletteRows'
import {
  promptTemplateFillReturnState,
  type PromptTemplateFillReturnState,
} from '@renderer/features/command-palette/lib/promptTemplateFillReturn'
import {
  body,
  primary,
  rankEntries,
  secondary,
} from '@renderer/features/command-palette/lib/rankEntries'
import { describeCommandState } from '@renderer/features/command-palette/commandState'
import type {
  CommandContext,
  CommandState,
  ResolvedCommand,
} from '@renderer/features/command-palette/types'
import type { PendingCommandInvocation } from '@renderer/app-state/uiShell/types'
import {
  allPromptTemplates,
} from '@renderer/features/prompt-templates/templates'
import {
  applyPromptTemplateInsertMode,
  fillPromptTemplateBody,
} from '@renderer/features/prompt-templates/interpolate'
import {
  createSavedPromptTemplate,
  duplicatePromptTemplate,
  findSavedPromptTemplate,
  syncTemplateVariablesFromBody,
  updateSavedPromptTemplate,
} from '@renderer/features/prompt-templates/savedPromptTemplates'
import {
  PromptTemplateEditorPane,
  type PromptTemplateEditorForm,
} from '@renderer/features/prompt-templates/ui/PromptTemplateEditorPane'
import { PromptTemplateFillPane } from '@renderer/features/prompt-templates/ui/PromptTemplateFillPane'
import { PromptTemplateManagerPane } from '@renderer/features/prompt-templates/ui/PromptTemplateManagerPane'
import { PromptTemplatePreviewPanel } from '@renderer/features/prompt-templates/ui/PromptTemplatePreviewPanel'
import type {
  PromptTemplate,
  PromptTemplateInsertMode,
  PromptTemplateVariableValueMap,
} from '@renderer/features/prompt-templates/types'
import { promptTemplateTargetSessionId } from '@renderer/features/prompt-templates/targetSession'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import type { PaletteMode } from '@renderer/features/command-palette/paletteMode'
import { commandOwnsOpenSurface } from '@renderer/features/command-palette/surfaceOwnership'
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
// shared contract prevents: the palette consumes `ListedSession[]` straight
// from `window.api.listSessionsForCwd`, which always returns the full shape,
// so the narrower local type was hiding fields rather than reflecting reality.
import type { ListedSession } from '@preload/api/session'
import { SessionPickerRow } from '@renderer/features/workspace/ui/SessionPickerRow'

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

type PromptTemplateFillState = {
  template: PromptTemplate
  values: PromptTemplateVariableValueMap
  insertMode: PromptTemplateInsertMode
  returnTo: PromptTemplateFillReturnState
}

// Global "reveal every command" escape hatch. Hard-coded false, moved
// here from App.tsx (#494): issue #249 shipped the per-command override
// mechanism only. A future "show hidden commands" affordance can flip
// this to reveal the full list in one shot.
const SHOW_HIDDEN_COMMANDS = false

/**
 * The ONE place a semantic command state becomes pixels.
 *
 * Both the palette row and the details pane render through this, so a state
 * cannot be coloured one way in the list and another in the preview — which is
 * what happened when each surface carried its own copy of the tone ternary.
 * Tone, label and muting all come from `describeCommandState`; nothing here
 * decides appearance from the state's contents directly.
 */
function CommandStateBadge({ state }: { state: CommandState }) {
  const presentation = describeCommandState(state)
  const tone =
    presentation.tone === 'danger'
      ? 'border-danger-border bg-danger-soft text-danger'
      : presentation.tone === 'accent'
        ? 'border-accent/30 bg-row-selected-bg text-accent'
        : 'border-panel-border bg-panel-elevated-bg text-muted'
  return (
    <span
      // `detail` carries the explanation the old flat label could not — the
      // reason Tail says On when this command cannot turn it off, or why
      // Caffeinate is unavailable on this platform.
      title={presentation.detail}
      className={`rounded-chip border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${tone}${
        presentation.muted ? ' opacity-60' : ''
      }`}
    >
      {presentation.label}
    </span>
  )
}

export function CommandPalette() {
  const open = useAppStore(state => state.commandPaletteOpen)
  // The pending invocation now lives in the STORE rather than in local state
  // here, because it no longer belongs only to the native menu. The keybinding
  // router is mounted in the workspace tree and needs the same channel: it also
  // cannot cheaply build a CommandContext (assembling ~76 workspace actions and
  // flags is precisely the cost this component avoids paying while closed,
  // #494), so a chord takes the route a menu click already took. One channel,
  // one dispatch path — rather than a second one growing beside it.
  const pendingCommandInvocation = useAppStore(state => state.pendingCommandInvocation)
  const requestCommandInvocation = useAppStore(state => state.requestCommandInvocation)
  const clearCommandInvocation = useAppStore(state => state.clearCommandInvocation)

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
        // ONE exemption, matching the keybinding router: the command that owns
        // the surface currently holding the interaction may dismiss it. Without
        // this, File → New Tab twice left the path picker up, and the rule this
        // change exists to establish — "invoking again dismisses it, from every
        // invocation source" — was true for chords and false for the menu.
        if (
          hasAppInteractionOwner()
          && !commandOwnsOpenSurface(commandId, useAppStore.getState())
        ) {
          return
        }
        // WHY this temporarily mounts the open implementation: command
        // definitions need live workspace actions, but keeping that registry
        // subscribed while the palette is closed made every session delta
        // rebuild an invisible feature. A menu click is rare and intentional, so
        // it may pay the one-time registry cost. useLayoutEffect below runs it
        // and closes before paint, avoiding a palette flash.
        requestCommandInvocation(commandId, 'native-menu')
      }),
    [requestCommandInvocation],
  )

  // WHY the workspace-heavy component does not exist while closed: returning
  // null at the bottom of the old monolith was too late. Hooks had already read
  // the monolithic workspace context, assembled ~76 command dependencies, and
  // built the registry. This outer gate subscribes to two store fields;
  // ordinary agent traffic cannot fan into the hidden palette.
  // Mount for a pending invocation too, but WITHOUT making the palette visible.
  // Previously `requestCommandInvocation` set `commandPaletteOpen: true`, so
  // every routed chord — including ⌥H/⌥J pane focus, the most repeated gesture
  // in the app — flashed the palette open and shut. Separating "the host is
  // mounted" from "the user can see it" keeps the #494 cost model (build the
  // context only when something actually needs it) without the flash.
  if (!open && !pendingCommandInvocation) return null
  return (
    <OpenCommandPalette
      visible={open}
      pendingMenuCommand={pendingCommandInvocation}
      onMenuCommandHandled={clearCommandInvocation}
    />
  )
}

function OpenCommandPalette({
  visible,
  pendingMenuCommand,
  onMenuCommandHandled,
}: {
  /** False when mounted purely to service a keybinding or menu invocation. */
  visible: boolean
  pendingMenuCommand: PendingCommandInvocation | null
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
  // Injected into the execution gateway so an async command failure is
  // visible. Before the gateway, every call site was `void command.run(ctx)`
  // and a rejected promise vanished with no user-facing signal at all.
  const { showToast } = useGlobalToast()
  const onClose = useAppStore(state => state.closeCommandPalette)
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const { onNewTabRequest } = usePathPickerRequests()

  const openTileTabsModal = useAppStore(state => state.openTileTabsModal)
  const onTileTabsRequest = useCallback(() => {
    openTileTabsModal(
      workspace.tileTabs?.tabIds ?? (workspace.activeTab ? [workspace.activeTab.id] : []),
    )
  }, [openTileTabsModal, workspace.activeTab, workspace.tileTabs])
  const onReorderTabsRequest = useAppStore(state => state.openReorderTabs)
  const onSettingsRequest = useAppStore(state => state.openSettingsPage)
  const openPaletteAction = useAppStore(state => state.openCommandPalette)
  const openViewPrompts = useAppStore(state => state.openViewPrompts)
  const openPromptSearch = useAppStore(state => state.openPromptSearch)
  const openAgentActivity = useAppStore(state => state.openAgentActivity)
  const openKeyboardShortcuts = useAppStore(state => state.openKeyboardShortcuts)
  const openCloseOldAgents = useAppStore(state => state.openCloseOldAgents)
  const openBulkProviderSwitch = useAppStore(state => state.openBulkProviderSwitch)
  const openRewindPrompt = useAppStore(state => state.openRewindPrompt)
  const openAgentViewModePicker = useAppStore(state => state.openAgentViewModePicker)
  const openColorFlagPicker = useAppStore(state => state.openColorFlagPicker)
  const openAgentTitlePrompt = useAppStore(state => state.openAgentTitlePrompt)
  const closeUsageModal = useAppStore(state => state.closeUsageModal)
  const closeKeyboardShortcuts = useAppStore(state => state.closeKeyboardShortcuts)
  const closeAgentActivity = useAppStore(state => state.closeAgentActivity)
  const closeCloseOldAgents = useAppStore(state => state.closeCloseOldAgents)
  const closeBulkProviderSwitch = useAppStore(state => state.closeBulkProviderSwitch)
  const closePromptSearch = useAppStore(state => state.closePromptSearch)
  const closeReorderTabs = useAppStore(state => state.closeReorderTabs)
  const closePinAgents = useAppStore(state => state.closePinAgents)
  const closePathPicker = useAppStore(state => state.closePathPicker)
  const openUsageModal = useAppStore(state => state.openUsageModal)
  const toggleGitBar = useAppStore(state => state.toggleGitBar)
  const toggleWorktreesBar = useAppStore(state => state.toggleWorktreesBar)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleRenderingDebugMode = useAppStore(state => state.toggleRenderingDebugMode)
  const toggleTailAllMode = useAppStore(state => state.toggleTailAllMode)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const toggleAgentStatusPanel = useAppStore(state => state.toggleAgentStatusPanel)
  const togglePerformancePanel = useAppStore(state => state.togglePerformancePanel)
  const toggleRemotePanel = useAppStore(state => state.toggleRemotePanel)
  const openGlobalEditorAction = useAppStore(state => state.openGlobalEditor)
  const closeGlobalEditorAction = useAppStore(state => state.closeGlobalEditor)
  const toggleGlobalEditor = useAppStore(state => state.toggleGlobalEditor)
  const openTiledDispatchPrompt = useAppStore(state => state.openTiledDispatchPrompt)
  const openDispatchAttach = useAppStore(state => state.openDispatchAttach)
  const openLinkedAgent = useAppStore(state => state.openLinkedAgent)
  const openPinAgents = useAppStore(state => state.openPinAgents)
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
  const setAggressiveDebugPersistence = useCallback(
    (enabled: boolean) => setSettings({ aggressiveDebugPersistence: enabled }),
    [setSettings],
  )

  const agentViewMode = settings.agentViewMode
  const commandVisibilityOverrides = settings.commandVisibilityOverrides
  const navigationCommandsEnabled = settings.navigationCommandsEnabled
  const promptTemplatesInCommandSearchEnabled =
    settings.promptTemplatesInCommandSearchEnabled
  const commandKeybindingOverrides = settings.commandKeybindingOverrides
  const showHiddenCommands = SHOW_HIDDEN_COMMANDS
  const statusModeEnabled = settings.showStatusMode
  const worktreeBadgesEnabled = settings.showWorktreeBadges
  const usageHeaderEnabled = settings.usageHeaderEnabled
  const usageHeaderLevel = settings.usageHeaderLevel
  const dangerousAgentsEnabled = settings.dangerousAgentsEnabled
  const aggressiveDebugPersistenceEnabled = settings.aggressiveDebugPersistence
  const commandPaletteOpenFlag = useAppStore(state => state.commandPaletteOpen)
  const usageModalOpen = useAppStore(state => state.usageModalOpen)
  const keyboardShortcutsOpen = useAppStore(state => state.keyboardShortcutsOpen)
  const agentActivityOpen = useAppStore(state => state.agentActivityOpen)
  const closeOldAgentsOpen = useAppStore(state => state.closeOldAgentsOpen)
  const bulkProviderSwitchOpen = useAppStore(state => state.bulkProviderSwitchOpen)
  const promptSearchOpen = useAppStore(state => state.promptSearchOpen)
  const remotePanelOpen = useAppStore(state => state.remotePanelOpen)
  const reorderTabsOpen = useAppStore(state => state.reorderTabsOpen)
  const pinAgentsOpen = useAppStore(state => state.pinAgentsOpen)
  const pathPickerOpen = useAppStore(state => state.pathPickerOpen)
  const gitBarOpen = useAppStore(state => state.gitBarOpen)
  const worktreesBarOpen = useAppStore(state => state.worktreesBarOpen)
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const renderingDebugMode = useAppStore(state => state.renderingDebugMode)
  const tailAllMode = useAppStore(state => state.tailAllMode)
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
  // Store-backed, not `useState` — see the note on `uiShell.paletteMode`. The
  // local version could not survive a chord invocation, which mounts this
  // component invisibly and destroys it in the same commit.
  const mode = useAppStore(state => state.paletteMode)
  const setMode = useAppStore(state => state.setPaletteMode)
  const [sessions, setSessions] = useState<ListedSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [aiWorkspaces, setAiWorkspaces] = useState<AiWorkspaceSummary[]>([])
  const [aiWorkspacesLoading, setAiWorkspacesLoading] = useState(false)
  const [aiWorkspaceError, setAiWorkspaceError] = useState<string | null>(null)
  const [aiWorkspacePending, setAiWorkspacePending] = useState<string | null>(null)
  const [armedAiWorkspaceClearId, setArmedAiWorkspaceClearId] = useState<string | null>(null)
  const [promptTemplateForm, setPromptTemplateForm] = useState<PromptTemplateEditorForm>({
    id: null,
    title: '',
    description: '',
    body: '',
    insertMode: 'replace',
    variables: [],
  })
  const [promptTemplateFillState, setPromptTemplateFillState] = useState<PromptTemplateFillState | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const focusedSessionId = commandTargetSessionId(workspace)
  const focusedMeta = focusedSessionId ? workspace.state.sessions[focusedSessionId] : null
  const promptTemplateSessionId = promptTemplateTargetSessionId(workspace)
  const promptTemplatesInCommandSearch =
    promptTemplatesInCommandSearchEnabled && promptTemplateSessionId !== null
  const focusedCwd = focusedMeta?.cwd ?? null
  const focusedProvider = focusedMeta?.kind ?? DEFAULT_PROVIDER
  const customPromptTemplates = settings.savedPromptTemplates
  // The provider whose sessions the resume picker lists and resumes into.
  // Use the focused pane's ACTUAL provider so an opencode pane resumes
  // opencode, a codex pane codex, etc. The three call sites below used to
  // read `focusedProvider === 'codex' ? 'codex' : 'claude'`, which silently
  // collapsed EVERY non-codex kind — including opencode (a registered
  // provider since phase 7) — to Claude. That made an opencode-focused
  // resume picker list Claude sessions and spawn a Claude pane, even though
  // the picker header already displayed "resume opencode". Terminal / unknown
  // kinds have no resume story, so fall back to the default provider.
  // Which provider's saved sessions the Resume picker lists.
  //
  // The focused pane's provider, but ONLY if main can actually enumerate saved
  // sessions for it. `listSessionsForCwd` has no index for OpenCode, so
  // focusing an OpenCode pane and hitting Resume opened a picker that would
  // always be empty — a dead end presented as a working feature, and the reason
  // `savedSessionListing` existed with nothing reading it.
  //
  // Falling back to the default provider rather than hiding Resume entirely:
  // the user's saved Claude sessions in this cwd are still there and still what
  // they most likely want. Hiding the command would take a working action away
  // because an unrelated pane happens to be focused.
  const resumeProvider: AgentProviderKind =
    isAgentProviderKind(focusedProvider) &&
    getProviderFeatures(focusedProvider).savedSessionListing
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
  }, [focusedCwd, resumeProvider])

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
    setMode('prompt-template')
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const enterManagePromptTemplateMode = useCallback(() => {
    setMode('manage-prompt-template')
    setQuery('')
    setSelectedIndex(0)
    setPromptTemplateFillState(null)
  }, [])

  const enterSavePromptTemplateMode = useCallback(() => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    const draft = workspace.getRuntime(sessionId).draftInput.trim()
    if (!draft) return
    setPromptTemplateForm({
      id: null,
      title: '',
      description: '',
      body: draft,
      insertMode: 'replace',
      variables: syncTemplateVariablesFromBody(draft, []),
    })
    setMode('save-prompt-template')
    setQuery('')
    setSelectedIndex(0)
  }, [workspace])

  const enterEditPromptTemplateMode = useCallback((template: PromptTemplate) => {
    if (template.scope !== 'custom') return
    setPromptTemplateForm({
      id: template.id,
      title: template.title,
      description: template.description,
      body: template.body,
      insertMode: template.insertMode,
      variables: template.variables,
    })
    setMode('edit-prompt-template')
    setQuery(template.title)
    setSelectedIndex(0)
  }, [])

  const enterDuplicatePromptTemplateMode = useCallback((template: PromptTemplate) => {
    const duplicate = duplicatePromptTemplate(template)
    setPromptTemplateForm({
      id: null,
      title: duplicate.title,
      description: duplicate.description,
      body: duplicate.body,
      insertMode: duplicate.insertMode,
      variables: duplicate.variables,
    })
    setMode('save-prompt-template')
    setQuery(duplicate.title)
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
        openTileTabs: onTileTabsRequest,
        openReorderTabs: onReorderTabsRequest,
        openSettings: onSettingsRequest,
        // Reachable through the gateway (keybinding, native menu, programmatic)
        // but never rendered as a palette row — see
        // PALETTE_SELF_EXCLUDED_COMMAND_IDS for why that exclusion is
        // structural rather than a visibility tier.
        openCommandPalette: openPaletteAction,
        openViewPrompts,
        openPromptSearch,
        openAgentActivity,
        openKeyboardShortcuts,
      openCloseOldAgents,
        openBulkProviderSwitch,
        openRewindPrompt,
        openAgentViewModePicker,
        openColorFlagPicker,
        openAgentTitlePrompt,
        closeUsageModal,
        closeKeyboardShortcuts,
        closeAgentActivity,
        closeCloseOldAgents,
        closeBulkProviderSwitch,
        closePromptSearch,
        closeReorderTabs,
        closePinAgents,
        closePathPicker,
        openUsageModal,
        toggleGitBar,
        toggleWorktreesBar,
        toggleDebugPanel,
        toggleFeedDebugPanel,
        toggleProxyDebugPanel,
        toggleHtmlDebugPanel,
        toggleRenderingDebugMode,
        toggleTailAllMode,
        toggleDevDebugPanel,
        toggleAgentStatusPanel,
        togglePerformancePanel,
        toggleRemotePanel,
        toggleCaffeinate,
        openGlobalEditor: openGlobalEditorAction,
        closeGlobalEditor: closeGlobalEditorAction,
        toggleGlobalEditor,
        toggleFileTreeVisible,
        enterDispatchMode,
        enterGlobalDispatch,
        exitDispatchMode,
        openTiledDispatchPrompt,
        openDispatchAttach,
        openLinkedAgent,
        openPinAgents,
        setAggressiveDebugPersistence,
        enterResumeMode,
        enterBuriedMode,
        enterKillBuriedMode,
        enterPromptTemplateMode,
        enterManagePromptTemplateMode,
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
        commandPaletteOpen: commandPaletteOpenFlag,
        paletteMode: mode,
        usageModalOpen,
        keyboardShortcutsOpen,
        agentActivityOpen,
        closeOldAgentsOpen,
        bulkProviderSwitchOpen,
        promptSearchOpen,
        remotePanelOpen,
        reorderTabsOpen,
        pinAgentsOpen,
        pathPickerOpen,
        gitBarOpen,
        worktreesBarOpen,
        debugPanelOpen,
        feedDebugPanelOpen,
        proxyDebugPanelOpen,
        htmlDebugPanelOpen,
        renderingDebugMode,
        tailAllMode,
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
        navigationCommandsEnabled,
        commandKeybindingOverrides,
        showHiddenCommands,
      },
    }),
    [
      workspace,
      onNewTabRequest,
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
      openAgentTitlePrompt,
      closeUsageModal,
      closeKeyboardShortcuts,
      closeAgentActivity,
      closeCloseOldAgents,
      closeBulkProviderSwitch,
      closePromptSearch,
      closeReorderTabs,
      closePinAgents,
      closePathPicker,
      openUsageModal,
      toggleGitBar,
      toggleWorktreesBar,
      toggleDebugPanel,
      toggleFeedDebugPanel,
      toggleProxyDebugPanel,
      toggleHtmlDebugPanel,
      toggleRenderingDebugMode,
      toggleTailAllMode,
      toggleDevDebugPanel,
      toggleAgentStatusPanel,
      togglePerformancePanel,
      toggleRemotePanel,
      toggleCaffeinate,
      openGlobalEditorAction,
      closeGlobalEditorAction,
      toggleGlobalEditor,
      toggleFileTreeVisible,
      enterDispatchMode,
      enterGlobalDispatch,
      exitDispatchMode,
      openTiledDispatchPrompt,
      openDispatchAttach,
      openLinkedAgent,
      openPinAgents,
      setAggressiveDebugPersistence,
      enterResumeMode,
      enterBuriedMode,
      enterKillBuriedMode,
      enterPromptTemplateMode,
      enterManagePromptTemplateMode,
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
      commandPaletteOpenFlag,
      mode,
      usageModalOpen,
      keyboardShortcutsOpen,
      agentActivityOpen,
      closeOldAgentsOpen,
      bulkProviderSwitchOpen,
      promptSearchOpen,
      remotePanelOpen,
      reorderTabsOpen,
      pinAgentsOpen,
      pathPickerOpen,
      gitBarOpen,
      worktreesBarOpen,
      debugPanelOpen,
      feedDebugPanelOpen,
      proxyDebugPanelOpen,
      htmlDebugPanelOpen,
      renderingDebugMode,
      tailAllMode,
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
      navigationCommandsEnabled,
      commandKeybindingOverrides,
      showHiddenCommands,
    ],
  )

  const commands = useMemo(() => buildCommandRegistry(commandContext), [commandContext])

  const promptTemplates = useMemo(
    () => allPromptTemplates(customPromptTemplates),
    [customPromptTemplates],
  )

  const queryText = query.trim()
  // Every list below goes through `rankEntries`, the same relevance core
  // `rankCommands` uses. They used to be boolean `.filter()`s with no
  // scoring, which meant the rendered order was just the source-array
  // order and match quality never entered into it. For prompt templates
  // that source order is `[...custom, ...builtin]`, so a builtin could
  // never outrank a custom one however much better it matched — typing
  // "read this p" buried the builtin "Read This Project" under six
  // unrelated custom templates. See
  // docs/plans_and_ideas/2026-07-22-palette-search-relevance-plan.md.
  //
  // Field weights are the whole design decision at each call site: what
  // the user is typing the name of is `primary`, short supporting text is
  // `secondary`, and long prose is `body` — which `rankEntries` matches
  // by literal substring only, never by subsequence.
  const filteredSessions = useMemo(
    () =>
      rankEntries(sessions, queryText, s => [
        // `summary` is `customTitle ?? lastPrompt ?? firstPrompt`
        // (sessionList.ts) — so for any session the user never titled by
        // hand, this "name" is really a prompt, and it is what the row
        // displays. Keeping it `primary` is a deliberate compromise: it
        // means prose can still claim tiers 4/5 and can still be
        // subsequence-matched at tier 1, which is the very thing this
        // module distrusts. The alternative is worse — demote it and the
        // text the user is LOOKING AT becomes the hardest thing to search
        // by. Matching must follow what is on screen. If session titling
        // ever becomes mandatory, revisit this.
        primary(s.summary),
        secondary(s.gitBranch),
        // Not unbounded: `extractFirstUserPrompt` caps this at 200 chars.
        // Still `body` — it is a prompt, not a label, and it is usually
        // hidden behind `summary` in the row.
        body(s.firstPrompt),
      ]),
    [sessions, queryText],
  )
  const filteredBuried = useMemo(
    () =>
      rankEntries(buried, queryText, item => [
        // `note` is the ONLY human-authored, row-distinguishing field
        // here, so it is the primary one despite not being the row's
        // headline. `label` is generated (`${kind} · ${cwdBase}`) and is
        // byte-identical for every pane buried from the same repo — as
        // primary it made tier 4 a mass tie that the note could never
        // break, and let an unrelated repo's provider name outrank a note
        // that literally started with the query.
        primary(item.note),
        secondary(item.label),
        // `${sourceTabTitle} · ${cwd}` — contains an absolute path, so as
        // a secondary field every buried pane matched "users",
        // "development", and every other path segment at tier 3.
        body(item.description),
      ]),
    [buried, queryText],
  )
  const filteredPromptTemplates = useMemo(
    () =>
      rankEntries(promptTemplates, queryText, template => [
        primary(template.title),
        secondary(template.description),
        body(template.body),
      ]),
    [promptTemplates, queryText],
  )
  const filteredAiWorkspaces = useMemo(
    () =>
      rankEntries(aiWorkspaces, queryText, workspace => [
        primary(workspace.name),
        secondary(workspace.description),
        // Ids are matched so a pasted id still finds its workspace, but
        // they are never what a human types by hand — and they are UUIDs,
        // never rendered in the row. As `secondary` they gave every
        // hex-alphabet fragment ("de", "bea", "aaef") the same weight as
        // a deliberate description match, so most of the list matched
        // most queries for reasons invisible on screen. `body` keeps the
        // paste-an-id path working while costing the user nothing.
        body(workspace.workspaceId),
      ]),
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
  // `commandStarred` is read here and threaded straight into ranking —
  // deliberately NOT into `commandContext.flags` the way
  // `commandVisibilityOverrides` is. Visibility has to live in flags because
  // `commandVisible` runs inside `buildCommandRegistry`; starring is applied
  // after the registry is built. Putting it in flags would add it to the
  // context memo's deps and rebuild all 99 commands — every function title,
  // every getState call, resolveEffectiveKeybindings — on every star toggle.
  const commandStarred = settings.commandStarred
  const handleToggleStar = useCallback(
    (commandId: string) => {
      const next = { ...commandStarred }
      // Prune rather than store `false`. The map holds deliberate stars only,
      // which is what makes "absent means not starred" total — the same rule
      // the visibility map follows when a value returns to its default.
      if (next[commandId]) delete next[commandId]
      else next[commandId] = true
      setSettings({ commandStarred: next })
    },
    [commandStarred, setSettings],
  )
  // The sort mode is a persisted browse preference, read the same way starring
  // is — straight from settings, deliberately NOT through `commandContext.flags`.
  // Same reasoning as the comment above: flags feed the context memo, and
  // putting a value there that changes on a menu click would rebuild all 99
  // commands (every function title, every getState, resolveEffectiveKeybindings)
  // to reorder a list that is already built.
  const commandSortMode = settings.commandSortMode
  const setCommandSortMode = useCallback(
    (next: CommandSortMode) => {
      setSettings({ commandSortMode: next })
      // Load-bearing, and for exactly the reason spelled out on the `setQuery`
      // handler below: a reordering that leaves the LENGTH unchanged is
      // invisible to both guards. The clamp effect keys on `filteredLength`,
      // which does not move; the scroll effect keys on `selectedIndex`, which
      // does not move either. So without this the highlight stays on row N
      // while row N becomes a completely different command, and Enter runs
      // something the user never looked at — and the catalog contains
      // destructive commands.
      //
      // Every `enter*Mode` callback resets the index for the same reason. The
      // sort control was the one reordering path that did not.
      setSelectedIndex(0)
    },
    [setSettings],
  )
  // `headers` is the section map for `grouped` mode and empty for every other
  // mode. It comes back from the SAME call that produced the ordering, so a
  // header can never be drawn above the wrong row — see `browseOrder`.
  const { rows: rankedPaletteRows, headers: commandGroupHeaders } = useMemo(
    () => rankPaletteRows({
      commands,
      promptTemplates,
      query: queryText,
      historyScore: historyScoreMap,
      starred: commandStarred,
      sortMode: commandSortMode,
      // A terminal is a valid generic command target but has no agent
      // composer. Hiding templates there matches the dedicated picker and
      // prevents an actionable-looking result whose execution can only no-op.
      includePromptTemplates: promptTemplatesInCommandSearch,
    }),
    [
      commands,
      promptTemplates,
      queryText,
      historyScoreMap,
      commandStarred,
      commandSortMode,
      promptTemplatesInCommandSearch,
    ],
  )
  const directAgentQuery = useMemo(
    () => parseAgentIndexPaletteQuery(queryText),
    [queryText],
  )
  const directAgentTarget = useMemo(
    () => directAgentQuery
      ? resolveAgentPaneLabel(
          workspace.state,
          directAgentQuery.label,
          workspace.tileTabs,
        )
      : null,
    [directAgentQuery, workspace.state, workspace.tileTabs],
  )
  // WHY the syntax intent is normalized against the visible surface before we
  // build the row: `A2!` can only mean "Here" when a Tiled Dispatch lane is on
  // screen. Persisted state can contain a hidden Dispatch layout underneath
  // Tiled Tabs, and grid/classic Dispatch deliberately retain ordinary
  // coordinate navigation. Passing the raw bang there would make row zero
  // promise "Open Here" while Enter actually switches to an existing pane.
  const directAgentIntent =
    directAgentQuery?.intent === 'open-in-focused-tiled-dispatch-lane' &&
    !workspace.tileTabs &&
    workspace.state.dispatchMode?.tiled
      ? directAgentQuery.intent
      : 'reuse-existing-view'
  const directAgentCommand = useMemo(
    () =>
      directAgentTarget && directAgentQuery
        ? buildAgentIndexCommand(
            directAgentTarget,
            workspace.focusAgentByPaneLabel,
            directAgentIntent,
          )
        : null,
    [
      directAgentIntent,
      directAgentQuery,
      directAgentTarget,
      workspace.focusAgentByPaneLabel,
    ],
  )
  // The exact coordinate result is deliberately row zero. It is not part of
  // fuzzy command ranking and must win Enter even if a future command happens
  // to contain "A2" in its title or keywords.
  const paletteRows = useMemo<CommandPaletteRow[]>(
    () => directAgentCommand
      ? [{ kind: 'command', command: directAgentCommand }, ...rankedPaletteRows]
      : rankedPaletteRows,
    [directAgentCommand, rankedPaletteRows],
  )

  // `commandGroupHeaders` is keyed by index into `rankedPaletteRows`, but the
  // rendered list is `paletteRows` — one longer whenever a direct agent
  // coordinate row is prepended. Shifting the lookup by that offset keeps the
  // two aligned.
  //
  // In practice the two are mutually exclusive: headers exist only for an EMPTY
  // query, and the agent-coordinate parser needs a query matching an exact
  // label with an optional trailing bang to produce a row at all. The offset
  // is here anyway because relying on that
  // coincidence would put a silent off-by-one behind any future change to
  // either rule, and the failure mode — every section heading sitting one row
  // too high — is exactly the kind of thing that ships unnoticed.
  const directAgentRowOffset = directAgentCommand ? 1 : 0

  /**
   * Index of the LAST starred row, so it can carry a rule separating the
   * pinned block from everything else. -1 when no separator should render.
   *
   * WHY only for an empty query: the pinned block only exists there.
   * `rankCommands` hard-partitions on an empty query, but during a search a
   * star is merely a same-tier tiebreak — starred and unstarred rows
   * legitimately interleave, so a rule drawn after the first run of starred
   * rows would imply a grouping that does not exist.
   *
   * Also -1 when every row is starred or none is, since a separator at the
   * very top or very bottom of the list divides nothing.
   *
   * ALSO -1 in `grouped` sort mode, added when sort modes landed: grouped mode
   * already renders a labelled "★ Starred" section, so the rule would draw a
   * second, unlabelled divider immediately under a heading that says the same
   * thing. Headers own the structure in that mode; this separator is the
   * fallback for the modes that have none.
   */
  const starredBoundaryIndex = useMemo(() => {
    if (queryText.length > 0) return -1
    if (commandSortMode === 'grouped') return -1
    let starredCount = 0
    for (const row of paletteRows) {
      if (row.kind !== 'command' || !commandStarred[row.command.id]) break
      starredCount += 1
    }
    if (starredCount === 0 || starredCount === paletteRows.length) return -1
    return starredCount - 1
  }, [commandSortMode, commandStarred, paletteRows, queryText])

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
              ? paletteRows.length
              : 0

  const selectedPaletteRow = useMemo(() => {
    if (mode !== 'commands') return null
    return paletteRows[selectedIndex] ?? null
  }, [mode, paletteRows, selectedIndex])

  const selectedCommand = useMemo(() => {
    return selectedPaletteRow?.kind === 'command' ? selectedPaletteRow.command : null
  }, [selectedPaletteRow])

  // Focus the search input whenever the palette becomes VISIBLE.
  //
  // This replaced a mount-time reset effect that also did the focusing. That
  // effect had a `mountedForPendingCommand` guard which, on inspection, is never
  // false: `openCommandPalette` has exactly one caller — the
  // `open-command-palette` command — and commands only run from inside this
  // host, which is already mounted when they do. So every mount carries a
  // pending invocation, the guard always returned early, and the focus call
  // went with it. A comment described a distinction with no other branch.
  //
  // The state resets it also performed were redundant on a fresh mount (the
  // `useState` initializers already give those values) and are gone. Focus is
  // not redundant, so it moves here, keyed on `visible` rather than on mount —
  // which is the moment it actually matters, and is correct for both paths:
  // opened directly, or opened into a sub-mode by a chord.
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [visible])

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
    // Resolve the row by its declared index, NOT by position among the
    // container's children.
    //
    // `children[selectedIndex]` assumed every child of the list is a selectable
    // row, and that was already false before grouping existed: the
    // `ai-workspace-open`/`clear` modes render an error banner as a sibling of
    // the rows, so while an error was showing every scroll target was off by
    // one. Grouped mode's section headings would have made it wrong in a fourth
    // mode. An explicit `data-palette-row` makes a row's index part of its
    // identity, so sibling chrome — banners, headings, anything added later —
    // can never shift it again.
    const el = listRef.current.querySelector(`[data-palette-row="${selectedIndex}"]`)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest' })
    }
    // `paletteRows` is a dependency, not just `selectedIndex`: switching sort
    // mode moves the selected row to a different scroll offset (grouped mode
    // inserts headers, which shifts everything below them) while the index may
    // be unchanged. Keyed on the index alone, the effect would not re-run and
    // the highlighted row could sit off-screen with nothing visibly selected.
  }, [selectedIndex, paletteRows])

  const executeCommand = useCallback(
    (command: ResolvedCommand) => {
      // Every palette execution — keyboard Enter and click alike — funnels
      // through the shared gateway. History is no longer recorded here: the
      // gateway records it AFTER a successful run, so a command that turns out
      // to be unavailable or that throws no longer climbs the user's ranking
      // for failing. It also owns transient-row exclusion, single-flight, and
      // surfacing async failures the old `void command.run(...)` swallowed.
      const dispatch = () =>
        void dispatchResolvedRow({
          row: command,
          source: 'palette',
          ctx: commandContext,
          reportError: message => showToast(message, 6000),
        })

      if (command.keepPaletteOpen) {
        dispatch()
        return
      }
      onClose()
      dispatch()
    },
    [commandContext, onClose, showToast],
  )

  // Native menu → command dispatch (issue #148).
  //
  // The macOS File menu lives in main, but its actions are renderer commands
  // that need the live CommandContext (workspace store + UI callbacks) to run.
  // Main can't run them; it only knows the command's string id. So main emits
  // the id over `menu:command` and we resolve + run it here.
  //
  // WHY this resolves through the gateway instead of `commands.find(...)`:
  // `commands` is the PICKER-FILTERED registry. Looking an id up there meant a
  // cosmetic `commandVisibilityOverrides[id] = false` — a "don't clutter my
  // palette" preference — made the File-menu item resolve to undefined and do
  // nothing. Silently. That is the plan's highest-severity finding: picker
  // visibility was acting as an authorization boundary it explicitly must not
  // be. The gateway resolves from the full catalog and applies contextual
  // admission only, so hiding a command can no longer disable its menu item.
  useLayoutEffect(() => {
    if (!pendingMenuCommand) return
    void dispatchCommand({
      // The SOURCE travels with the request, so a chord is recorded as a
      // keybinding invocation and a File-menu click as a native-menu one. A
      // hardcoded source here would have made every keyboard invocation look
      // like a menu click in personalized history.
      id: pendingMenuCommand.id,
      source: pendingMenuCommand.source,
      ctx: commandContext,
      reportError: message => showToast(message, 6000),
    })
    onMenuCommandHandled()
    // A command that OPENED the palette must not be closed by the "return to
    // where you were" rule. `closeAfterRun` records that the palette was shut
    // when the invocation was requested; honouring it blindly would open the
    // palette and shut it in the same frame, and the chord would look broken.
    //
    // CAVEAT, because the rule is not unconditional: `dispatchCommand` is not
    // awaited, so this reads the flag at the first `await` inside `run`. A
    // command that opens the palette only AFTER an await would be closed in the
    // same frame. All nine mode-entering commands set the mode in their
    // synchronous prefix (`enterResumeMode` sets 'resume' before its await), so
    // the property holds today — but a future command must open the palette
    // before its first await for it to keep holding.
    //
    // The test is the LIVE flag, read after `run`, rather than a hardcoded id
    // list. That list held only `open-command-palette`, and it could only ever
    // have held ids someone remembered to add — it would not have covered the
    // nine mode-entering commands, which need exactly the same exemption for
    // exactly the same reason. "Did this command turn the palette on?" answers
    // for all of them, and for anything added later, without an enumeration to
    // keep in sync.
    if (pendingMenuCommand.closeAfterRun && !useAppStore.getState().commandPaletteOpen) {
      onClose()
    }
  }, [commandContext, onClose, onMenuCommandHandled, pendingMenuCommand, showToast])

  const executeResume = useCallback(
    (session: ListedSession) => {
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
    async (template: PromptTemplate, originSelectedIndex = selectedIndex) => {
      const sessionId = promptTemplateSessionId
      if (!sessionId) return

      try {
        const body = template.buildBody
          ? await template.buildBody({ workspace, sessionId })
          : template.body
        if (template.variables.length > 0) {
          setPromptTemplateFillState({
            template: template.buildBody ? { ...template, body } : template,
            values: {},
            insertMode: template.insertMode,
            returnTo: promptTemplateFillReturnState(mode, query, originSelectedIndex),
          })
          setMode('fill-prompt-template')
          setQuery('')
          setSelectedIndex(0)
          return
        }
        // Template insertion deliberately stops at the draft boundary.
        // The user's next action is still visible and editable in the
        // composer; nothing is sent to Claude/Codex until they press
        // Enter themselves. This mirrors rewind-to-prompt's "prefill,
        // don't replay" contract.
        const currentDraft = workspace.getRuntime(sessionId).draftInput
        workspace.setDraftInput(sessionId, applyPromptTemplateInsertMode(currentDraft, body, template.insertMode))
        workspace.showPaneToast(sessionId, `Inserted template: ${template.title}`)
        onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        workspace.showPaneToast(sessionId, `Template failed: ${message}`)
      }
    },
    [mode, onClose, promptTemplateSessionId, query, selectedIndex, workspace],
  )

  const savePromptTemplateForm = useCallback(() => {
    const title = promptTemplateForm.title.trim()
    const description = promptTemplateForm.description.trim()
    const body = promptTemplateForm.body.trim()
    if (!title || !body) return

    const sessionId = commandTargetSessionId(workspace)
    const existing = promptTemplateForm.id
      ? findSavedPromptTemplate(customPromptTemplates, promptTemplateForm.id)
      : null
    const template = existing
      ? updateSavedPromptTemplate(existing, {
        title,
        description,
        body,
        insertMode: promptTemplateForm.insertMode,
        variables: promptTemplateForm.variables,
      })
      : createSavedPromptTemplate({
        title,
        description,
        body,
        insertMode: promptTemplateForm.insertMode,
        variables: promptTemplateForm.variables,
      })
    const savedPromptTemplates = existing
      ? customPromptTemplates.map(candidate => candidate.id === existing.id ? template : candidate)
      : [template, ...customPromptTemplates]

    setSettings({ savedPromptTemplates })
    setPromptTemplateForm({
      id: null,
      title: '',
      description: '',
      body: '',
      insertMode: 'replace',
      variables: [],
    })
    setMode('manage-prompt-template')
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
  }, [customPromptTemplates, promptTemplateForm, setSettings, workspace])

  const openAiWorkspace = useCallback(
    (workspaceId: string) => {
      useGlobalEditorStore.getState().openAiWorkspace(workspaceId)
      // Idempotent open — see the note on `ui.openGlobalEditor`.
      openGlobalEditorAction()
      onClose()
    },
    [onClose, openGlobalEditorAction],
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
      setSettings({
        savedPromptTemplates: customPromptTemplates.filter(candidate => candidate.id !== template.id),
      })
      setSelectedIndex(i => Math.max(0, Math.min(i, customPromptTemplates.length - 2)))
    },
    [customPromptTemplates, setSettings],
  )

  const insertFilledPromptTemplate = useCallback(() => {
    const fill = promptTemplateFillState
    if (!fill) return
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    try {
      const resolved = fillPromptTemplateBody({
        body: fill.template.body,
        variables: fill.template.variables,
        values: fill.values,
      })
      const currentDraft = workspace.getRuntime(sessionId).draftInput
      workspace.setDraftInput(
        sessionId,
        applyPromptTemplateInsertMode(currentDraft, resolved, fill.insertMode),
      )
      workspace.showPaneToast(sessionId, `Inserted template: ${fill.template.title}`)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      workspace.showPaneToast(sessionId, `Template failed: ${message}`)
    }
  }, [onClose, promptTemplateFillState, workspace])

  const cancelPromptTemplateFill = useCallback(() => {
    const returnTo = promptTemplateFillState?.returnTo ?? {
      mode: 'prompt-template' as const,
      query: '',
      selectedIndex: 0,
    }
    setPromptTemplateFillState(null)
    setMode(returnTo.mode)
    setQuery(returnTo.query)
    setSelectedIndex(returnTo.selectedIndex)
  }, [promptTemplateFillState, setMode])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        // Clamp the ceiling at 0, not at filteredLength - 1. Modes that render
        // their own pane instead of the shared list (the template manager,
        // editor, and fill panes) deliberately report filteredLength 0, which
        // made the old ceiling -1 and pushed selectedIndex negative. Nothing
        // crashed because every consumer index-guards, but the index then had
        // to be walked back up through 0 before the list responded again.
        setSelectedIndex(prev => Math.min(prev + 1, Math.max(0, filteredLength - 1)))
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
        // The manager pane is entirely button-driven — rows and their
        // Edit/Dup/Delete actions are real <button>s, and the input above it
        // is a plain search field with no highlighted row to commit. It needs
        // an explicit no-op branch because it is the only template mode whose
        // input stays writable: save/edit/fill are readOnly, so their stray
        // keystrokes never reach here. Without this the mode fell through to
        // the command-registry `else` below and ran paletteRows[
        // selectedIndex] — typing "kill" to filter templates and pressing
        // Enter fired the Kill command instead of doing nothing.
        if (mode === 'manage-prompt-template') return
        if (mode === 'save-prompt-template' || mode === 'edit-prompt-template') {
          savePromptTemplateForm()
        } else if (mode === 'fill-prompt-template') {
          insertFilledPromptTemplate()
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
          const row = paletteRows[selectedIndex]
          if (row?.kind === 'prompt-template') void executePromptTemplate(row.template)
          else if (row?.kind === 'command') executeCommand(row.command)
        }
      }
    },
    [
      mode,
      aiWorkspacePending,
      filteredLength,
      filteredBuried,
      paletteRows,
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
      insertFilledPromptTemplate,
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
    // dangling. `filteredSessions` is typed `ListedSession[]`, so the
    // cast is belt-and-suspenders against noUncheckedIndexedAccess.
    const session = filteredSessions[selectedIndex] as ListedSession | undefined
    if (!session) return null
    const cwd = session.cwd ?? focusedCwd
    if (!cwd) return null
    return {
      kind: resumeProvider,
      cwd,
      providerSessionId: session.sessionId,
    }
  })()

  // The template preview panel mirrors the highlighted row for the same reason
  // `resumePreviewTarget` does, and by the same mechanism: every row calls
  // `onMouseEnter={() => setSelectedIndex(i)}`, so hover and keyboard (↑/↓)
  // both write this one index. Deriving the previewed template from it means
  // the panel follows hover AND arrow keys with no hover state of its own.
  //
  // WHY not a local `hoveredTemplate` state (the obvious implementation): it
  // would be a second source of truth that keyboard navigation never updates,
  // so arrowing down the list would leave the panel showing whatever the mouse
  // last touched. It also needs onMouseLeave handling that this does not.
  //
  // `filteredPromptTemplates` is the array `selectedIndex` indexes into — the
  // same one the keyboard handler and the rendered rows use. The cast mirrors
  // `resumePreviewTarget` above and exists for noUncheckedIndexedAccess.
  const selectedPromptTemplate: PromptTemplate | null = mode === 'prompt-template'
    ? (filteredPromptTemplates[selectedIndex] as PromptTemplate | undefined) ?? null
    : null

  return (
    <Dialog
      // `visible` is false when this component was mounted only to service a
      // keybinding or native-menu invocation. The host still needs to exist —
      // it owns the CommandContext the gateway dispatches against — but Radix
      // must not portal a modal, trap focus, or mark the background inert for a
      // chord the user pressed to do something else entirely.
      open={visible}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className={`
          rounded-float
          top-[12vh] translate-y-0 flex flex-col p-0
          bg-popover-bg border border-popover-border
          shadow-[0_16px_48px_var(--theme-shadow-color)]
          overflow-hidden
          ${
            mode === 'resume'
              ? 'w-[min(1180px,95vw)] max-h-[80vh]'
              : // `prompt-template` joins the other template modes rather than
                // sitting with the compact list modes. Two reasons, both from
                // the preview panel:
                //
                // 1. The mode now renders a full prompt body, and the 60vh cap
                //    was chosen for a list of one-line command rows. Capping
                //    the surface that exists to show long prompts at 60vh
                //    hides the feature behind a scrollbar.
                // 2. Enter on a template WITH variables transitions
                //    prompt-template -> fill-prompt-template. While the two
                //    modes disagreed on size, that transition visibly jumped
                //    the dialog from 900px/60vh to 1080px/82vh mid-interaction.
                //    Sharing the geometry makes the step seamless.
                mode === 'prompt-template' ||
                  mode === 'manage-prompt-template' ||
                  mode === 'save-prompt-template' ||
                  mode === 'edit-prompt-template' ||
                  mode === 'fill-prompt-template'
                ? 'w-[min(1080px,95vw)] max-h-[82vh]'
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
          if (mode === 'edit-prompt-template' || mode === 'save-prompt-template') {
            setMode('manage-prompt-template')
          } else if (mode === 'fill-prompt-template') {
            // Fill has two entry points now. Returning through the captured
            // origin keeps Escape and the visible Cancel button identical.
            cancelPromptTemplateFill()
            return
          } else {
            setMode('commands')
          }
          setPromptTemplateForm({
            id: null,
            title: '',
            description: '',
            body: '',
            insertMode: 'replace',
            variables: [],
          })
          setPromptTemplateFillState(null)
          setQuery('')
          setSelectedIndex(0)
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          {mode === 'commands' && promptTemplatesInCommandSearch
            ? 'Search application commands, prompt templates, and related session workflows.'
            : 'Search application commands and related session workflows.'}
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
          {mode === 'manage-prompt-template' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              manage templates &rsaquo;
            </span>
          )}
          {mode === 'fill-prompt-template' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              fill template &rsaquo;
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
                ? 'Template editor'
                : mode === 'manage-prompt-template'
                  ? 'Search managed templates…'
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
                ? ''
                : mode === 'fill-prompt-template'
                  ? ''
                : query
            }
            onChange={e => {
              if (mode === 'save-prompt-template' || mode === 'edit-prompt-template') {
                return
              } else if (mode === 'fill-prompt-template') {
                return
              } else {
                setQuery(e.target.value)
              }
              // Load-bearing, and more so since the lists became ranked:
              // EVERY `setQuery` must be paired with `setSelectedIndex(0)`.
              // The old boolean filters were monotone — typing another
              // character could only remove rows, never reorder the
              // survivors — so a stale index stayed on the same row.
              // A ranked list can reorder at UNCHANGED length (add a
              // character and a tier-1 row swaps with a tier-5 one), which
              // the `Math.min(prev, filteredLength - 1)` clamp cannot
              // catch because the length never changed. Dropping this line
              // means Enter silently runs a different row than the one the
              // user was looking at.
              setSelectedIndex(0)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            readOnly={
              mode === 'save-prompt-template' ||
              mode === 'edit-prompt-template' ||
              mode === 'fill-prompt-template'
            }
          />
          {mode === 'prompt-template' && (
            <Button variant="outline" size="sm" onClick={enterManagePromptTemplateMode}>
              Manage
            </Button>
          )}
          {/* Commands mode only. The other ten modes render short, intrinsically
              ordered lists (session recency, buried-at time, [...custom,
              ...builtin]) where a sort control would be chrome without a
              purpose — the command list is the only one long enough to be hard
              to scan. */}
          {mode === 'commands' && (
            <CommandSortControl
              mode={commandSortMode}
              onChange={setCommandSortMode}
              searching={queryText.length > 0}
            />
          )}
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            ref={listRef}
            className={`
              min-h-0 py-1
              ${
                // `prompt-template` shares the commands geometry because it
                // now has the same two-column shape: a list yielding 70% to a
                // 30% detail panel, with the divider owned by the list. The
                // `min-w-0` is what actually lets the panel claim its basis —
                // without it the flex list refuses to shrink below its content
                // width and squeezes the aside out. The bare `flex-1` fallback
                // stays for the single-column modes (editor/manager/fill).
                mode === 'commands' || mode === 'prompt-template'
                  ? 'flex-1 min-w-0 overflow-y-auto md:basis-[70%] md:border-r md:border-border'
                  : mode === 'resume'
                    ? 'flex-1 min-w-0 overflow-y-auto md:flex-none md:w-[42%] md:border-r md:border-border'
                    : 'flex-1 overflow-y-auto'
              }
            `}
          >
            {(mode === 'save-prompt-template' || mode === 'edit-prompt-template') && (
              <PromptTemplateEditorPane
                form={promptTemplateForm}
                onChange={next => {
                  const variables = next.body === promptTemplateForm.body
                    ? next.variables
                    : syncTemplateVariablesFromBody(next.body, next.variables)
                  setPromptTemplateForm({ ...next, variables })
                }}
                onCancel={() => {
                  setPromptTemplateForm({
                    id: null,
                    title: '',
                    description: '',
                    body: '',
                    insertMode: 'replace',
                    variables: [],
                  })
                  setMode('manage-prompt-template')
                  setQuery('')
                  setSelectedIndex(0)
                }}
                onSave={savePromptTemplateForm}
              />
            )}

            {mode === 'manage-prompt-template' && (
              <PromptTemplateManagerPane
                templates={filteredPromptTemplates}
                onUse={template => void executePromptTemplate(template)}
                onCreate={() => {
                  setPromptTemplateForm({
                    id: null,
                    title: '',
                    description: '',
                    body: '',
                    insertMode: 'replace',
                    variables: [],
                  })
                  setMode('save-prompt-template')
                }}
                onEdit={enterEditPromptTemplateMode}
                onDuplicate={enterDuplicatePromptTemplateMode}
                onDelete={deletePromptTemplate}
              />
            )}

            {mode === 'fill-prompt-template' && promptTemplateFillState && (
              <PromptTemplateFillPane
                template={promptTemplateFillState.template}
                values={promptTemplateFillState.values}
                insertMode={promptTemplateFillState.insertMode}
                onValueChange={(name, value) => {
                  setPromptTemplateFillState(state => state ? {
                    ...state,
                    values: { ...state.values, [name]: value },
                  } : state)
                }}
                onInsertModeChange={insertMode => {
                  setPromptTemplateFillState(state => state ? { ...state, insertMode } : state)
                }}
                onCancel={() => {
                  cancelPromptTemplateFill()
                }}
                onInsert={insertFilledPromptTemplate}
              />
            )}

            {mode === 'commands' &&
              (paletteRows.length === 0 ? (
                <div className="px-3 py-4 text-muted text-[12px] text-center">
                  {promptTemplatesInCommandSearch && queryText.length > 0
                    ? 'No matching commands or prompt templates'
                    : 'No matching commands'}
                </div>
              ) : (
                paletteRows.map((row, i) => {
                  const groupHeader = commandGroupHeaders.get(i - directAgentRowOffset)
                  if (row.kind === 'prompt-template') {
                    const template = row.template
                    return (
                      <div
                        key={`prompt-template:${template.id}`}
                        data-palette-row={i}
                        className={`
                          flex items-center justify-between gap-3
                          px-3 py-1.5
                          cursor-pointer
                          font-code
                          ${
                            i === selectedIndex
                              ? 'bg-row-selected-bg text-row-selected-fg'
                              : 'text-ink-dim hover:bg-row-hover-bg'
                          }
                        `}
                        onMouseEnter={() => setSelectedIndex(i)}
                        onClick={() => void executePromptTemplate(template, i)}
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          {/* The command rows reserve this column for a star.
                              Keeping the same width prevents mixed search rows
                              from zig-zagging horizontally, while a distinct
                              glyph makes template insertion visually different
                              from command execution before the user presses Enter. */}
                          <span
                            aria-hidden
                            className="w-3 flex-shrink-0 text-center text-[12px] leading-none text-accent"
                          >
                            ›
                          </span>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2 text-[13px]">
                              <span className="truncate">{template.title}</span>
                              <span className="flex-shrink-0 rounded-chip border border-border bg-surface px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted">
                                Prompt template
                              </span>
                            </div>
                            {template.description && (
                              <div className="mt-0.5 truncate text-[10px] text-muted">
                                {template.description}
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
                          {template.scope}
                        </span>
                      </div>
                    )
                  }

                  const command = row.command
                  return (
                    <Fragment key={command.id}>
                      {groupHeader && (
                        <div
                          // A section heading, not a selectable row: `selectedIndex`
                          // indexes `paletteRows`, and headings live outside that
                          // array entirely. Arrow keys, Enter, hover and the clamp
                          // effect are all untouched by grouping — which is why the
                          // header map is keyed by command index rather than the list
                          // being restructured into sections.
                          //
                          // Deliberately NOT aria-hidden. Non-selectable is a reason
                          // to give it no role or tabindex, not a reason to remove it
                          // from the accessibility tree: grouped mode's entire value
                          // IS the structure, so hiding the labels would make it
                          // announce identically to catalog mode.
                          role="presentation"
                          className="
                            px-3 pt-3 pb-1
                            text-[9px] font-code uppercase tracking-[0.14em] text-muted
                            first:pt-1
                          "
                        >
                          {groupHeader}
                        </div>
                      )}
                      <div
                        data-palette-row={i}
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
                        ${i === starredBoundaryIndex ? 'border-b border-border' : ''}
                      `}
                        onMouseEnter={() => setSelectedIndex(i)}
                        onClick={() => executeCommand(command)}
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          {/* Marks starred rows in the list itself. Without it the
                              pinned block at the top looked like an arbitrary
                              reordering — the star lived only in the detail pane,
                              so identifying which commands were pinned meant
                              selecting them one at a time. Fixed-width so titles
                              stay left-aligned whether or not a row is starred. */}
                          <span
                            aria-hidden
                            className={`w-3 flex-shrink-0 text-center text-[12px] leading-none ${
                              commandStarred[command.id] ? 'text-accent' : 'text-transparent'
                            }`}
                          >
                            ★
                          </span>
                          {/* The glyph above is aria-hidden because announcing
                              "star" on all 102 rows is noise. But starred state was
                              then conveyed only visually, so a screen-reader user
                              got a list silently reordered for a reason they could
                              not perceive. This says it once, only where it is
                              true. */}
                          {commandStarred[command.id] ? <span className="sr-only">Starred. </span> : null}
                          <span>{command.title}</span>
                          {command.state && <CommandStateBadge state={command.state} />}
                        </div>
                        {command.shortcut && (
                          <span className="ml-3 flex-shrink-0 text-[11px] text-muted">
                            {command.shortcut}
                          </span>
                        )}
                      </div>
                    </Fragment>
                  )
                })
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
                    data-palette-row={i}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => executeResume(session)}
                  >
                    {/* Identity is resolved in main through the shared ladder
                        (#96). The chain this replaced —
                        `summary || firstPrompt || sessionId` — could fall all
                        the way through to a FULL untruncated uuid, and had no
                        way to tell the user that is what they were looking at. */}
                    <SessionPickerRow identity={session.identity} />
                  </div>
                ))
              ))}

            {(mode === 'ai-workspace-open' || mode === 'ai-workspace-clear') && (
              <>
                {aiWorkspaceError ? (
                  <div
                    role="alert"
                    className="rounded-slab mx-2 my-1 border border-danger/40 bg-danger/10 px-2 py-2 text-[11px] text-danger"
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
                        data-palette-row={i}
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
                    className="rounded-slab mb-3 border border-danger/40 bg-danger/10 px-2 py-2 text-[11px] text-danger"
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
                    className="rounded-control border border-control-border bg-control-hover-bg px-2 py-1 text-[11px] text-muted hover:text-ink"
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
                    className="rounded-control border border-accent bg-accent px-2 py-1 text-[11px] text-accent-fg disabled:opacity-40"
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
                    data-palette-row={i}
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
                    data-palette-row={i}
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
                    data-palette-row={i}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => void executePromptTemplate(template)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="min-w-0 flex-1 text-[12px] truncate">{template.title}</div>
                      {template.scope === 'custom' && (
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <button
                            type="button"
                            className="rounded-control border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
                            onClick={e => {
                              e.stopPropagation()
                              enterEditPromptTemplateMode(template)
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded-control border border-danger-border bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger hover:text-danger"
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

          {mode === 'commands' && (
            selectedPaletteRow?.kind === 'prompt-template' ? (
              <PromptTemplatePreviewPanel template={selectedPaletteRow.template} />
            ) : (
              <CommandDescriptionPanel
                command={selectedCommand}
                starred={selectedCommand ? commandStarred[selectedCommand.id] === true : false}
                onToggleStar={handleToggleStar}
              />
            )
          )}

          {/* Prompt-template mode — the full prompt body for the highlighted
              template. Same breakpoint policy as the command description panel
              (hidden below md) so the narrow layout stays list-only. */}
          {mode === 'prompt-template' && (
            <PromptTemplatePreviewPanel template={selectedPromptTemplate} />
          )}

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
  starred,
  onToggleStar,
}: {
  command: ResolvedCommand | null
  starred: boolean
  // MUST be useCallback-stable in the parent. This component is memo'd on a
  // tiny prop set precisely because the palette re-renders on every keystroke;
  // an inline arrow here would defeat that and re-render the markdown body of
  // the description on every character typed.
  onToggleStar: (commandId: string) => void
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
      <div className="mb-3 flex items-start justify-between gap-2 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">{command.title}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            {command.shortcut && <span>{command.shortcut}</span>}
            {command.state && <CommandStateBadge state={command.state} />}
          </div>
        </div>
        {/* Suppressed for the synthetic agent-index row: its id is per-session
            and per-query (`agent-index:<sessionId>`), so starring one would
            write a permanently dead key into settings that can never match
            anything again and that the retired-id prune cannot recognise. The
            history recorder skips these rows for the same reason. */}
        {!isAgentIndexCommand(command) ? (
          // Sized as a real control, not a glyph. The first version was a
          // 13px character with `px-1` and no height — about a 13x13 target in
          // `text-muted`, which on the canvas background was close to
          // invisible and awkward to hit. A star is the only interactive
          // element in this pane, so it has to read as pressable: 24x24 hit
          // area (the floor for a comfortable pointer target), 16px glyph, a
          // border that appears on hover, and `text-ink-dim` rather than
          // `text-muted` when unstarred so the outline is legible at rest.
          <button
            type="button"
            aria-pressed={starred}
            aria-label={starred ? 'Unstar command' : 'Star command'}
            title={starred ? 'Unstar command' : 'Star command'}
            onClick={() => onToggleStar(command.id)}
            className={`rounded-control
              flex h-6 w-6 shrink-0 items-center justify-center border
              text-[16px] leading-none
              ${starred
                ? 'border-transparent text-accent hover:border-control-border-hover'
                : 'border-transparent text-ink-dim hover:border-control-border-hover hover:text-ink'}
            `}
          >
            {starred ? '★' : '☆'}
          </button>
        ) : null}
      </div>
      <div>
        <ReactMarkdown components={COMMAND_DESCRIPTION_COMPONENTS}>
          {command.description}
        </ReactMarkdown>
      </div>
    </aside>
  )
})
