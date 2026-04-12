import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Workspace } from './tiles/workspaceStore'

// CommandPalette — VS Code-style ⌘⇧P command menu.
//
// Two modes:
//   1. Commands mode (default) — flat list of app commands, fuzzy filtered.
//   2. Resume mode — fetches previous sessions for the focused pane's cwd
//      and shows them inline. Selecting one resumes it in a new tab.
//      Escape goes back to commands mode.
//
// The resume sub-mode is entered via the "Resume Session" command. It
// detects the focused pane's provider (claude/codex) automatically.

export type CommandDef = {
  id: string
  label: string
  /** Shortcut hint shown on the right side of the row. Display only. */
  shortcut?: string
  /** Called when the user selects this command. */
  action: (ctx: CommandContext) => void | Promise<void>
}

export type CommandContext = {
  workspace: Workspace
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
  toggleGitBar: () => void
  /** Enter resume sub-mode inside the palette (instead of closing). */
  enterResumeMode: () => void
  close: () => void
}

export function buildCommands(): CommandDef[] {
  return [
    {
      id: 'new-tab',
      label: 'New Tab',
      shortcut: '⌘T',
      action: ({ onNewTabRequest }) => onNewTabRequest(),
    },
    {
      id: 'close-tab',
      label: 'Close Tab',
      shortcut: '⌘⇧W',
      action: ({ workspace }) => {
        if (workspace.activeTab) void workspace.closeTab(workspace.activeTab.id)
      },
    },
    {
      id: 'next-tab',
      label: 'Next Tab',
      shortcut: '⌘]',
      action: ({ workspace }) => workspace.nextTab(),
    },
    {
      id: 'prev-tab',
      label: 'Previous Tab',
      shortcut: '⌘[',
      action: ({ workspace }) => workspace.prevTab(),
    },
    {
      id: 'resume-session',
      label: 'Resume Session',
      shortcut: '⌘⇧R',
      // Instead of opening the path picker, enter the inline resume
      // sub-mode so the user can pick a session without leaving the
      // palette.
      action: ({ enterResumeMode }) => enterResumeMode(),
    },
    {
      id: 'split-vertical',
      label: 'Split Pane Right',
      shortcut: '⌥D',
      action: ({ workspace }) => void workspace.splitFocused('vertical'),
    },
    {
      id: 'split-horizontal',
      label: 'Split Pane Down',
      shortcut: '⌥⇧D',
      action: ({ workspace }) => void workspace.splitFocused('horizontal'),
    },
    {
      id: 'close-pane',
      label: 'Close Pane',
      shortcut: '⌘W',
      action: ({ workspace }) => void workspace.closeFocused(),
    },
    {
      id: 'terminal-horizontal',
      label: 'New Terminal Below',
      shortcut: '⌥T',
      action: ({ workspace }) =>
        void workspace.splitFocused('horizontal', 'terminal'),
    },
    {
      id: 'terminal-vertical',
      label: 'New Terminal Right',
      shortcut: '⌥⇧T',
      action: ({ workspace }) =>
        void workspace.splitFocused('vertical', 'terminal'),
    },
    {
      id: 'nav-left',
      label: 'Focus Pane Left',
      shortcut: '⌥H',
      action: ({ workspace }) => workspace.navigate('left'),
    },
    {
      id: 'nav-right',
      label: 'Focus Pane Right',
      shortcut: '⌥L',
      action: ({ workspace }) => workspace.navigate('right'),
    },
    {
      id: 'nav-up',
      label: 'Focus Pane Up',
      shortcut: '⌥K',
      action: ({ workspace }) => workspace.navigate('up'),
    },
    {
      id: 'nav-down',
      label: 'Focus Pane Down',
      shortcut: '⌥J',
      action: ({ workspace }) => workspace.navigate('down'),
    },
    {
      id: 'undo-close',
      label: 'Undo Close',
      shortcut: '⌘⇧T',
      action: ({ workspace }) => void workspace.undoClose(),
    },
    {
      id: 'normalize-layout',
      label: 'Normalize Layout',
      action: ({ workspace }) => workspace.normalizeLayout(),
    },
    {
      id: 'hard-normalize-layout',
      label: 'Hard Normalize Layout',
      action: ({ workspace }) => workspace.hardNormalizeLayout(),
    },
    {
      id: 'rotate-layout',
      label: 'Rotate Layout',
      action: ({ workspace }) => workspace.rotateLayout(),
    },
    {
      id: 'toggle-git-bar',
      label: 'Toggle Git Bar',
      action: ({ toggleGitBar }) => toggleGitBar(),
    },
  ]
}

function fuzzyMatch(label: string, query: string): boolean {
  const lower = label.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

// --- Session info shape (mirrors preload) ---
type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}

type PaletteMode = 'commands' | 'resume'

type Props = {
  open: boolean
  onClose: () => void
  workspace: Workspace
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
  toggleGitBar: () => void
}

export function CommandPalette({
  open,
  onClose,
  workspace,
  onNewTabRequest,
  onResumeRequest,
  toggleGitBar,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<PaletteMode>('commands')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo(() => buildCommands(), [])

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
    if (!query.trim()) return commands
    return commands.filter(c => fuzzyMatch(c.label, query))
  }, [mode, commands, sessions, query])

  // Detect the focused pane's cwd and provider for resume mode.
  const focusedMeta = workspace.activeTab
    ? workspace.state.sessions[workspace.activeTab.focusedSessionId]
    : null
  const focusedCwd = focusedMeta?.cwd ?? null
  const focusedProvider = focusedMeta?.kind ?? 'claude'

  // Enter resume sub-mode: fetch sessions and switch.
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

  // Reset everything when the palette opens/closes.
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setMode('commands')
      setSessions([])
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Keep selectedIndex in bounds.
  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Scroll selected into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const executeCommand = useCallback(
    (cmd: CommandDef) => {
      const ctx: CommandContext = {
        workspace,
        onNewTabRequest,
        onResumeRequest,
        toggleGitBar,
        enterResumeMode,
        close: onClose,
      }
      // Resume mode is special — don't close the palette.
      if (cmd.id === 'resume-session') {
        void cmd.action(ctx)
        return
      }
      onClose()
      void cmd.action(ctx)
    },
    [workspace, onNewTabRequest, onResumeRequest, toggleGitBar, enterResumeMode, onClose],
  )

  const executeResume = useCallback(
    (session: SessionInfo) => {
      onClose()
      if (!focusedCwd) return
      // Replace the focused pane's session in-place instead of opening
      // a new tab. The tile tree stays the same — only the backing
      // session swaps to the resumed one.
      void workspace.replaceSession(focusedCwd, {
        resumeSessionId: session.sessionId,
        kind: focusedProvider === 'codex' ? 'codex' : 'claude',
      })
    },
    [onClose, focusedCwd, focusedProvider, workspace],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // In resume mode, Escape goes back to commands.
        if (mode === 'resume') {
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
          const s = filtered[selectedIndex] as SessionInfo | undefined
          if (s) executeResume(s)
        } else {
          const cmd = filtered[selectedIndex] as CommandDef | undefined
          if (cmd) executeCommand(cmd)
        }
        return
      }
    },
    [mode, filtered, selectedIndex, executeCommand, executeResume, onClose],
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
        {/* Search input */}
        <div className="flex-shrink-0 border-b border-border px-3 py-2 flex items-center gap-2">
          {mode === 'resume' && (
            <span className="text-accent text-[11px] flex-shrink-0 select-none">
              resume {focusedProvider} &rsaquo;
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

        {/* List */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {mode === 'commands' && (
            filtered.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No matching commands
              </div>
            ) : (
              (filtered as CommandDef[]).map((cmd, i) => (
                <div
                  key={cmd.id}
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
                  onClick={() => executeCommand(cmd)}
                >
                  <span>{cmd.label}</span>
                  {cmd.shortcut && (
                    <span className="text-muted text-[11px] ml-4 flex-shrink-0">
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              ))
            )
          )}

          {mode === 'resume' && sessionsLoading && (
            <div className="px-3 py-4 text-muted text-[12px] text-center">
              Loading sessions…
            </div>
          )}

          {mode === 'resume' && !sessionsLoading && (
            filtered.length === 0 ? (
              <div className="px-3 py-4 text-muted text-[12px] text-center">
                No sessions found
              </div>
            ) : (
              (filtered as SessionInfo[]).map((s, i) => (
                <div
                  key={s.sessionId}
                  className={`
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
                  onClick={() => executeResume(s)}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate flex-1 min-w-0">
                      {s.firstPrompt || s.summary || s.sessionId.slice(0, 8)}
                    </span>
                    <span className="text-muted text-[11px] ml-3 flex-shrink-0">
                      {formatRelativeTime(s.lastModified)}
                    </span>
                  </div>
                  {s.gitBranch && (
                    <div className="text-muted text-[11px]">
                      {s.gitBranch}
                    </div>
                  )}
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
