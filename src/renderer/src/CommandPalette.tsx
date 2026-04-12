import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Workspace } from './tiles/workspaceStore'

// CommandPalette — VS Code-style ⌘⇧P command menu.
//
// Renders as a centered overlay near the top of the window. The user
// types to fuzzy-filter a flat list of commands; Up/Down navigate;
// Enter executes; Escape closes. Focus is trapped inside the palette
// while it's open — no keystrokes leak to the composer or the PTY.
//
// Commands are defined declaratively as a static array. Each entry
// carries a human label, an optional shortcut hint, and an `action`
// callback that receives the workspace + helpers so it can fire any
// mutation. The list is intentionally not dynamic (no per-session
// commands yet) — we can add context-aware items later if needed.

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
  /** Open the new-tab flow (same as ⌘T). */
  onNewTabRequest: () => void
  /** Open the resume flow (same as ⌘⇧R). */
  onResumeRequest: (defaultCwd: string) => void
  /** Close the palette after executing. Already called automatically
   *  — provided so commands that do async work can close early. */
  close: () => void
}

// Static command registry. Order here is the default display order
// (before filtering). Grouped loosely by domain: tabs, panes,
// terminals, settings.
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
      action: ({ workspace, onResumeRequest }) => {
        const tab = workspace.activeTab
        const cwd = tab
          ? workspace.state.sessions[tab.focusedSessionId]?.cwd ?? ''
          : ''
        onResumeRequest(cwd)
      },
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
  ]
}

// Fuzzy filter: split the query into chars and check that they appear
// in order in the label. Case-insensitive. Simple and fast enough for
// a ~20-item list.
function fuzzyMatch(label: string, query: string): boolean {
  const lower = label.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

type Props = {
  open: boolean
  onClose: () => void
  workspace: Workspace
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
}

export function CommandPalette({
  open,
  onClose,
  workspace,
  onNewTabRequest,
  onResumeRequest,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo(() => buildCommands(), [])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    return commands.filter(c => fuzzyMatch(c.label, query))
  }, [commands, query])

  // Reset state when opened.
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      // Focus the input on the next frame so the modal is mounted.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Keep selectedIndex in bounds when the filtered list changes.
  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Scroll the selected item into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const execute = useCallback(
    (cmd: CommandDef) => {
      onClose()
      const ctx: CommandContext = {
        workspace,
        onNewTabRequest,
        onResumeRequest,
        close: onClose,
      }
      void cmd.action(ctx)
    },
    [workspace, onNewTabRequest, onResumeRequest, onClose],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
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
        const cmd = filtered[selectedIndex]
        if (cmd) execute(cmd)
        return
      }
    },
    [filtered, selectedIndex, execute, onClose],
  )

  if (!open) return null

  return (
    // Backdrop — click outside to dismiss.
    <div
      className="fixed inset-0 z-50 flex justify-center"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
    >
      {/* Palette container — stops click propagation so clicking
          inside doesn't dismiss. Positioned near the top of the
          window like VS Code's palette. */}
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
        <div className="flex-shrink-0 border-b border-border px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            className="
              w-full bg-transparent
              text-ink text-[13px] font-code
              outline-none
              placeholder:text-muted
            "
            placeholder="Type a command…"
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

        {/* Command list */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-muted text-[12px] text-center">
              No matching commands
            </div>
          ) : (
            filtered.map((cmd, i) => (
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
                onClick={() => execute(cmd)}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="text-muted text-[11px] ml-4 flex-shrink-0">
                    {cmd.shortcut}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
