import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { buildCommandRegistry } from './commands/registry'
import type { CommandContext, ResolvedCommand } from './commands/types'
import type { Workspace } from './tiles/workspaceStore'

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

type PaletteMode = 'commands' | 'resume' | 'buried'

type Props = {
  open: boolean
  onClose: () => void
  workspace: Workspace
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
  onTileTabsRequest: () => void
  onSettingsRequest: () => void
  openViewPrompts: (sessionId: string) => void
  openPromptSearch: () => void
  toggleGitBar: () => void
  toggleDebugPanel: () => void
  toggleProxyDebugPanel: () => void
  toggleCustomRendering: () => void
  customRenderingEnabled: boolean
  dangerousAgentsEnabled: boolean
  setDangerousAgentsEnabled: (enabled: boolean) => void
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
  onSettingsRequest,
  openViewPrompts,
  openPromptSearch,
  toggleGitBar,
  toggleDebugPanel,
  toggleProxyDebugPanel,
  toggleCustomRendering,
  customRenderingEnabled,
  dangerousAgentsEnabled,
  setDangerousAgentsEnabled,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<PaletteMode>('commands')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const focusedMeta = workspace.activeTab
    ? workspace.state.sessions[workspace.activeTab.focusedSessionId]
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

  const buried = useMemo<BuriedPaneInfo[]>(
    () =>
      [...workspace.state.buried]
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
    [workspace.state.buried],
  )

  const enterBuriedMode = useCallback(() => {
    setMode('buried')
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const commandContext = useMemo<CommandContext>(
    () => ({
      workspace,
      ui: {
        openNewTabPicker: onNewTabRequest,
        openResumePicker: onResumeRequest,
        openTileTabs: onTileTabsRequest,
        openSettings: onSettingsRequest,
        openViewPrompts,
        openPromptSearch,
        toggleGitBar,
        toggleDebugPanel,
        toggleProxyDebugPanel,
        toggleCustomRendering,
        setDangerousAgentsEnabled,
        enterResumeMode,
        enterBuriedMode,
        closePalette: onClose,
      },
      flags: {
        customRenderingEnabled,
        dangerousAgentsEnabled,
      },
    }),
    [
      workspace,
      onNewTabRequest,
      onResumeRequest,
      onTileTabsRequest,
      onSettingsRequest,
      openViewPrompts,
      openPromptSearch,
      toggleGitBar,
      toggleDebugPanel,
      toggleProxyDebugPanel,
      toggleCustomRendering,
      setDangerousAgentsEnabled,
      enterResumeMode,
      enterBuriedMode,
      onClose,
      customRenderingEnabled,
      dangerousAgentsEnabled,
    ],
  )

  const commands = useMemo(
    () => buildCommandRegistry(commandContext),
    [commandContext],
  )

  const filtered = useMemo(() => {
    if (mode === 'resume') {
      if (!query.trim()) return sessions
      return sessions.filter(
        s =>
          fuzzyMatch(s.summary, query) ||
          fuzzyMatch(s.firstPrompt ?? '', query) ||
          fuzzyMatch(s.gitBranch ?? '', query),
      )
    }
    if (mode === 'buried') {
      if (!query.trim()) return buried
      return buried.filter(
        item =>
          fuzzyMatch(item.label, query) ||
          fuzzyMatch(item.description, query) ||
          fuzzyMatch(item.note ?? '', query),
      )
    }
    if (!query.trim()) return commands
    return commands.filter(
      command =>
        fuzzyMatch(command.title, query) ||
        command.keywords.some(keyword => fuzzyMatch(keyword, query)),
    )
  }, [mode, buried, commands, sessions, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setMode('commands')
      setSessions([])
      setSessionsLoading(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const executeCommand = useCallback(
    (command: ResolvedCommand) => {
      if (command.id === 'resume-session' || command.id === 'revive-pane') {
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'resume' || mode === 'buried') {
          setMode('commands')
          setQuery('')
          setSelectedIndex(0)
          return
        }
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (mode === 'resume') {
          const session = filtered[selectedIndex] as SessionInfo | undefined
          if (session) executeResume(session)
        } else if (mode === 'buried') {
          const item = filtered[selectedIndex] as BuriedPaneInfo | undefined
          if (item) executeBuried(item)
        } else {
          const command = filtered[selectedIndex] as ResolvedCommand | undefined
          if (command) executeCommand(command)
        }
      }
    },
    [mode, filtered, selectedIndex, executeBuried, executeCommand, executeResume, onClose],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
    >
      <div
        className="
          mt-[12vh] w-[min(560px,90vw)]
          max-h-[60vh] flex flex-col
          bg-surface border border-border
          shadow-lg shadow-black/30
          overflow-hidden
        "
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
              mode === 'resume'
                ? 'Search sessions…'
                : mode === 'buried'
                  ? 'Search buried panes…'
                  : 'Type a command…'
            }
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {mode === 'commands' &&
            (filtered.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No matching commands
              </div>
            ) : (
              (filtered as ResolvedCommand[]).map((command, i) => (
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
                  <span>{command.title}</span>
                  {command.shortcut && (
                    <span className="text-[11px] text-muted">{command.shortcut}</span>
                  )}
                </div>
              ))
            ))}

          {mode === 'resume' &&
            (sessionsLoading ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                Loading sessions…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No matching sessions
              </div>
            ) : (
              (filtered as SessionInfo[]).map((session, i) => (
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
            (filtered.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No buried panes
              </div>
            ) : (
              (filtered as BuriedPaneInfo[]).map((item, i) => (
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
        </div>
      </div>
    </div>
  )
}
