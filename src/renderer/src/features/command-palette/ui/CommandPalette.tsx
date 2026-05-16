import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import { buildCommandRegistry } from '@renderer/features/command-palette/registry'
import type { CommandContext, ResolvedCommand } from '@renderer/features/command-palette/types'
import {
  allPromptTemplates,
  deleteCustomPromptTemplate,
  loadCustomPromptTemplates,
  saveCustomPromptTemplate,
  updateCustomPromptTemplate,
  type PromptTemplate,
} from '@renderer/features/prompt-templates/templates'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  SessionPreviewPane,
  type PreviewTarget,
} from '@renderer/features/session-preview/ui/SessionPreviewPane'

// CommandPalette — VS Code-style ⌘⇧P command menu.
//
// The palette itself now only owns search / selection / the resume
// sub-mode UI. The command registry lives outside this component
// under feature-owned folders, so adding a feature command no longer
// requires editing the palette implementation itself.

type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}

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

type PromptTemplateForm = {
  id: string | null
  title: string
  body: string
}

type Props = {
  open: boolean
  onClose: () => void
  workspace: Workspace
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
  onTileTabsRequest: () => void
  onReorderTabsRequest: () => void
  onSettingsRequest: () => void
  openViewPrompts: (sessionId: string) => void
  openPromptSearch: () => void
  openAgentActivity: () => void
  openRewindPrompt: (sessionId: string) => void
  toggleGitBar: () => void
  toggleWorktreesBar: () => void
  toggleDebugPanel: () => void
  toggleFeedDebugPanel: () => void
  toggleProxyDebugPanel: () => void
  toggleHtmlDebugPanel: () => void
  toggleDevDebugPanel: () => void
  togglePerformancePanel: () => void
  toggleGlobalEditor: () => void
  toggleFileTreeVisible: () => void
  enterDispatchMode: () => Promise<void> | void
  enterGlobalDispatch: () => Promise<void> | void
  exitDispatchMode: () => void
  openDispatchAttach: (sessionId: string) => void
  openPinAgents: () => void
  toggleCustomRendering: () => void
  toggleStatusMode: () => void
  toggleWorktreeBadges: () => void
  customRenderingEnabled: boolean
  statusModeEnabled: boolean
  worktreeBadgesEnabled: boolean
  dangerousAgentsEnabled: boolean
  aggressiveDebugPersistenceEnabled: boolean
  gitBarOpen: boolean
  worktreesBarOpen: boolean
  debugPanelOpen: boolean
  feedDebugPanelOpen: boolean
  proxyDebugPanelOpen: boolean
  htmlDebugPanelOpen: boolean
  devDebugEnabled: boolean
  devDebugPanelOpen: boolean
  performancePanelOpen: boolean
  globalEditorOpen: boolean
  fileTreeVisible: boolean
  dispatchModeEnabled: boolean
  globalDispatchEnabled: boolean
  setDangerousAgentsEnabled: (enabled: boolean) => void
  setAggressiveDebugPersistence: (enabled: boolean) => void
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

export function CommandPalette({
  open,
  onClose,
  workspace,
  onNewTabRequest,
  onResumeRequest,
  onTileTabsRequest,
  onReorderTabsRequest,
  onSettingsRequest,
  openViewPrompts,
  openPromptSearch,
  openAgentActivity,
  openRewindPrompt,
  toggleGitBar,
  toggleWorktreesBar,
  toggleDebugPanel,
  toggleFeedDebugPanel,
  toggleProxyDebugPanel,
  toggleHtmlDebugPanel,
  toggleDevDebugPanel,
  togglePerformancePanel,
  toggleGlobalEditor,
  toggleFileTreeVisible,
  enterDispatchMode,
  enterGlobalDispatch,
  exitDispatchMode,
  openDispatchAttach,
  openPinAgents,
  toggleCustomRendering,
  toggleStatusMode,
  toggleWorktreeBadges,
  customRenderingEnabled,
  statusModeEnabled,
  worktreeBadgesEnabled,
  dangerousAgentsEnabled,
  aggressiveDebugPersistenceEnabled,
  gitBarOpen,
  worktreesBarOpen,
  debugPanelOpen,
  feedDebugPanelOpen,
  proxyDebugPanelOpen,
  htmlDebugPanelOpen,
  devDebugEnabled,
  devDebugPanelOpen,
  performancePanelOpen,
  globalEditorOpen,
  fileTreeVisible,
  dispatchModeEnabled,
  globalDispatchEnabled,
  setDangerousAgentsEnabled,
  setAggressiveDebugPersistence,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<PaletteMode>('commands')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [customPromptTemplates, setCustomPromptTemplates] = useState<PromptTemplate[]>([])
  const [promptTemplateForm, setPromptTemplateForm] = useState<PromptTemplateForm>({
    id: null,
    title: '',
    body: '',
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const focusedSessionId = commandTargetSessionId(workspace)
  const focusedMeta = focusedSessionId
    ? workspace.state.sessions[focusedSessionId]
    : null
  const focusedCwd = focusedMeta?.cwd ?? null
  const focusedProvider = focusedMeta?.kind ?? 'claude'

  const enterResumeMode = useCallback(async () => {
    if (!focusedCwd) return
    setMode('resume')
    setQuery('')
    setSelectedIndex(0)
    setSessionsLoading(true)
    try {
      const list = await window.api.listSessionsForCwd(
        focusedCwd,
        20,
        focusedProvider === 'codex' ? 'codex' : 'claude',
      )
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
          const kind = entry.sessionMeta.kind ?? 'claude'
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
        openRewindPrompt,
        toggleGitBar,
        toggleWorktreesBar,
        toggleDebugPanel,
        toggleFeedDebugPanel,
        toggleProxyDebugPanel,
        toggleHtmlDebugPanel,
        toggleDevDebugPanel,
        togglePerformancePanel,
        toggleGlobalEditor,
        toggleFileTreeVisible,
        enterDispatchMode,
        enterGlobalDispatch,
        exitDispatchMode,
        openDispatchAttach,
        openPinAgents,
        toggleCustomRendering,
        toggleStatusMode,
        toggleWorktreeBadges,
        setDangerousAgentsEnabled,
        setAggressiveDebugPersistence,
        enterResumeMode,
        enterBuriedMode,
        enterKillBuriedMode,
        enterPromptTemplateMode,
        enterSavePromptTemplateMode,
        closePalette: onClose,
      },
      flags: {
        customRenderingEnabled,
        statusModeEnabled,
        worktreeBadgesEnabled,
        dangerousAgentsEnabled,
        aggressiveDebugPersistenceEnabled,
        gitBarOpen,
        worktreesBarOpen,
        debugPanelOpen,
        feedDebugPanelOpen,
        proxyDebugPanelOpen,
        htmlDebugPanelOpen,
        devDebugEnabled,
        devDebugPanelOpen,
        performancePanelOpen,
        globalEditorOpen,
        fileTreeVisible,
        dispatchModeEnabled,
        globalDispatchEnabled,
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
      openRewindPrompt,
      toggleGitBar,
      toggleWorktreesBar,
      toggleDebugPanel,
      toggleFeedDebugPanel,
      toggleProxyDebugPanel,
      toggleHtmlDebugPanel,
      toggleDevDebugPanel,
      togglePerformancePanel,
      toggleGlobalEditor,
      toggleFileTreeVisible,
      enterDispatchMode,
      enterGlobalDispatch,
      exitDispatchMode,
      openDispatchAttach,
      openPinAgents,
      toggleCustomRendering,
      toggleStatusMode,
      toggleWorktreeBadges,
      setDangerousAgentsEnabled,
      setAggressiveDebugPersistence,
      enterResumeMode,
      enterBuriedMode,
      enterKillBuriedMode,
      enterPromptTemplateMode,
      enterSavePromptTemplateMode,
      onClose,
      customRenderingEnabled,
      statusModeEnabled,
      worktreeBadgesEnabled,
      dangerousAgentsEnabled,
      aggressiveDebugPersistenceEnabled,
      gitBarOpen,
      worktreesBarOpen,
      debugPanelOpen,
      feedDebugPanelOpen,
      proxyDebugPanelOpen,
      htmlDebugPanelOpen,
      devDebugEnabled,
      devDebugPanelOpen,
      performancePanelOpen,
      globalEditorOpen,
      fileTreeVisible,
      dispatchModeEnabled,
      globalDispatchEnabled,
    ],
  )

  const commands = useMemo(
    () => buildCommandRegistry(commandContext),
    [commandContext],
  )

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
  const filteredCommands = useMemo(
    () =>
      queryText
        ? commands.filter(
            command =>
              fuzzyMatch(command.title, queryText) ||
              command.keywords.some(keyword => fuzzyMatch(keyword, queryText)),
          )
        : commands,
    [commands, queryText],
  )

  const filteredLength =
    mode === 'resume'
      ? filteredSessions.length
      : mode === 'buried' || mode === 'kill-buried'
        ? filteredBuried.length
        : mode === 'prompt-template'
          ? filteredPromptTemplates.length
          : mode === 'commands'
            ? filteredCommands.length
            : 0

  const selectedCommand = useMemo(() => {
    if (mode !== 'commands') return null
    return filteredCommands[selectedIndex] ?? null
  }, [filteredCommands, mode, selectedIndex])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setMode('commands')
      setSessions([])
      setSessionsLoading(false)
      setPromptTemplateForm({ id: null, title: '', body: '' })
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, filteredLength - 1)))
  }, [filteredLength])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex]
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const executeCommand = useCallback(
    (command: ResolvedCommand) => {
      if (command.keepPaletteOpen) {
        void command.run(commandContext)
        return
      }
      onClose()
      void command.run(commandContext)
    },
    [commandContext, onClose],
  )

  const executeResume = useCallback(
    (session: SessionInfo) => {
      onClose()
      if (!focusedCwd) return
      void workspace.replaceSession(focusedCwd, {
        resumeSessionId: session.sessionId,
        kind: focusedProvider === 'codex' ? 'codex' : 'claude',
      })
    },
    [onClose, focusedCwd, focusedProvider, workspace],
  )

  const executeBuried = useCallback(
    (item: BuriedPaneInfo) => {
      onClose()
      workspace.reviveBuried(item.id)
    },
    [onClose, workspace],
  )

  const executeKillBuried = useCallback(
    (item: BuriedPaneInfo) => {
      const remainingCount = filteredBuried
        .filter(candidate => candidate.id !== item.id)
        .length
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
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (
          mode === 'resume' ||
          mode === 'buried' ||
          mode === 'kill-buried' ||
          mode === 'prompt-template' ||
          mode === 'save-prompt-template'
        ) {
          setMode(mode === 'save-prompt-template' ? 'commands' : 'commands')
          setPromptTemplateForm({ id: null, title: '', body: '' })
          setQuery('')
          setSelectedIndex(0)
          return
        }
        if (mode === 'edit-prompt-template') {
          setMode('prompt-template')
          setPromptTemplateForm({ id: null, title: '', body: '' })
          setQuery('')
          setSelectedIndex(0)
          return
        }
        onClose()
        return
      }
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
        if (mode === 'save-prompt-template' || mode === 'edit-prompt-template') {
          savePromptTemplateForm()
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
          const command = filteredCommands[selectedIndex]
          if (command) executeCommand(command)
        }
      }
    },
    [
      mode,
      filteredLength,
      filteredBuried,
      filteredCommands,
      filteredPromptTemplates,
      filteredSessions,
      selectedIndex,
      executeBuried,
      executeCommand,
      executeKillBuried,
      executePromptTemplate,
      executeResume,
      savePromptTemplateForm,
      onClose,
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
    const session = filtered[selectedIndex] as SessionInfo | undefined
    if (!session) return null
    const cwd = session.cwd ?? focusedCwd
    if (!cwd) return null
    return {
      kind: focusedProvider === 'codex' ? 'codex' : 'claude',
      cwd,
      providerSessionId: session.sessionId,
    }
  })()

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
    >
      <div
        className={`
          mt-[12vh] flex flex-col
          bg-surface border border-border
          shadow-lg shadow-black/30
          overflow-hidden
          ${mode === 'resume'
            ? 'w-[min(1180px,95vw)] max-h-[80vh]'
            : 'w-[min(900px,92vw)] max-h-[60vh]'}
        `}
        onClick={e => e.stopPropagation()}
      >
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
            <span className="text-red-300 text-[11px] flex-shrink-0 select-none">
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
                : mode === 'resume'
                ? 'Search sessions…'
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
                setPromptTemplateForm(form => ({ ...form, title: e.target.value }))
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
              ${mode === 'commands'
                ? 'flex-1 min-w-0 overflow-y-auto md:basis-[70%] md:border-r md:border-border'
                : mode === 'resume'
                  ? 'flex-1 min-w-0 overflow-y-auto md:flex-none md:w-[42%] md:border-r md:border-border'
                  : 'flex-1 overflow-y-auto'}
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
                  setPromptTemplateForm(form => ({ ...form, body: e.target.value }))
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
                  className="border border-border bg-surface-hi px-2 py-1 text-[11px] text-muted hover:text-ink"
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
            (filteredCommands.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No matching commands
              </div>
            ) : (
              filteredCommands.map((command, i) => (
                <div
                  key={command.id}
                  className={`
                    flex items-center justify-between
                    px-3 py-1.5
                    cursor-pointer
                    text-[13px] font-code
                    ${
                      i === selectedIndex
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-dim hover:bg-surface-hi'
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
                            ? 'rounded border border-red-600/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-red-300'
                            : command.state.tone === 'accent'
                              ? 'rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent'
                              : 'rounded border border-border bg-surface-hi px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted'
                        }
                      >
                        {command.state.label}
                      </span>
                    )}
                  </div>
                  {command.shortcut && (
                    <span className="ml-3 flex-shrink-0 text-[11px] text-muted">{command.shortcut}</span>
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
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-dim hover:bg-surface-hi'
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

          {mode === 'buried' &&
            (filteredBuried.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No buried panes
              </div>
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
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-dim hover:bg-surface-hi'
                    }
                  `}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => executeBuried(item)}
                >
                  <div className="text-[12px] truncate">{item.label}</div>
                  {item.note && (
                    <div className="text-[11px] text-ink mt-0.5 truncate">
                      {item.note}
                    </div>
                  )}
                  <div className="text-[10px] text-muted mt-0.5 truncate">
                    {item.description}
                  </div>
                </div>
              ))
            ))}

          {mode === 'kill-buried' &&
            (filteredBuried.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No buried panes
              </div>
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
                        ? 'bg-red-500/15 text-ink'
                        : 'text-ink-dim hover:bg-surface-hi'
                    }
                  `}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => executeKillBuried(item)}
                >
                  <div className="text-[12px] truncate">{item.label}</div>
                  {item.note && (
                    <div className="text-[11px] text-ink mt-0.5 truncate">
                      {item.note}
                    </div>
                  )}
                  <div className="text-[10px] text-muted mt-0.5 truncate">
                    {item.description}
                  </div>
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
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-dim hover:bg-surface-hi'
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
                          className="border border-red-600/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300 hover:text-red-200"
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
            <CommandDescriptionPanel command={selectedCommand} />
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
      </div>
    </div>
  )
}

const COMMAND_DESCRIPTION_COMPONENTS: import('react-markdown').Options['components'] = {
  p: ({ children }) => (
    <p className="mb-2 text-[11px] leading-[1.55] text-ink-dim last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
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
                  ? 'border border-red-600/40 bg-red-500/10 px-1.5 py-0.5 uppercase tracking-wider text-red-300'
                  : command.state.tone === 'accent'
                    ? 'border border-accent/30 bg-accent/10 px-1.5 py-0.5 uppercase tracking-wider text-accent'
                    : 'border border-border bg-surface-hi px-1.5 py-0.5 uppercase tracking-wider text-muted'
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
