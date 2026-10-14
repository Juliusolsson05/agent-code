// The composer's slash-command picker for catalog providers (Hermes, #1497).
//
// WHY a separate picker from Claude's (providers/claude/renderer/
// SlashCommandPicker + SlashPickerParser): Claude's picker MIRRORS Claude
// Code's own terminal dropdown, so the selection lives in the PTY. A
// structured provider has no terminal; its catalog arrives as data
// (AgentSession.listComposerCommands), so selection, filtering and keys live
// here. The presentational SlashCommandPicker is reused for the look.
//
// Keys while open: Up/Down move, Tab completes, Enter completes a partial
// name (and lets an exact `/name` through to the normal submit), Escape
// closes until the draft changes.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { ComposerCommand } from '@shared/composerCommands/types'
import type { PickerItem, SlashPickerState } from '@shared/sessionFeed/types'

const MAX_ITEMS = 12

/** Which part of a slash draft the picker is completing, or null when it is not a slash draft. */
export function slashQuery(input: string): { name: string; arg: string | null } | null {
  const match = /^\/(\S*)(?:\s+(\S*))?$/.exec(input)
  if (!match) return null
  return { name: match[1]!.toLowerCase(), arg: match[2] === undefined ? (/\s$/.test(input) ? '' : null) : match[2]!.toLowerCase() }
}

/**
 * Ranked candidates for a typed name: the command's own name before its
 * aliases, prefixes before substrings. Recorded S17: `/comp` must put
 * `/compress` above `/prompt`, whose alias is `compose`.
 */
export function rankCommands(commands: readonly ComposerCommand[], typed: string): ComposerCommand[] {
  const visible = commands.filter((command) => command.availability.kind !== 'hidden')
  if (!typed) return visible.slice(0, MAX_ITEMS)
  const tier = (command: ComposerCommand): number => {
    if (command.name.startsWith(typed)) return 0
    if (command.aliases.some((alias) => alias.startsWith(typed))) return 1
    if (command.name.includes(typed)) return 2
    if (command.aliases.some((alias) => alias.includes(typed))) return 3
    return 4
  }
  return visible
    .map((command, order) => ({ command, order, rank: tier(command) }))
    .filter((entry) => entry.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_ITEMS)
    .map((entry) => entry.command)
}

function describe(command: ComposerCommand): string {
  if (command.availability.kind === 'unavailable') return `Unavailable here: ${command.availability.reason}`
  return command.description
}

export type ComposerCommandPicker = {
  state: SlashPickerState | null
  /** True when the picker consumed the key. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerCommandPicker({
  sessionId,
  enabled,
  input,
  setInputText,
  load = (id: string) => window.api.composerCommands(id),
}: {
  sessionId: string
  enabled: boolean
  input: string
  setInputText: (next: string) => void
  /** Injected for tests; the real one is the session:composerCommands IPC. */
  load?: (sessionId: string) => Promise<ComposerCommand[]>
}): ComposerCommandPicker {
  const [commands, setCommands] = useState<ComposerCommand[] | null>(null)
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const query = enabled ? slashQuery(input) : null
  const loading = useRef(false)

  // Fetched once per session, when a slash draft first appears: no IPC on
  // every keystroke, nothing at all for a pane where nobody types `/`.
  useEffect(() => {
    if (!query || commands || loading.current) return
    loading.current = true
    void load(sessionId)
      .then((list) => setCommands(list))
      .catch(() => setCommands([]))
      .finally(() => {
        loading.current = false
      })
  }, [query, commands, load, sessionId])

  useEffect(() => {
    setCommands(null)
  }, [sessionId])

  const candidates = useMemo((): Array<{ label: string; description: string; complete: string }> => {
    if (!query || !commands || dismissedFor === input) return []
    if (query.arg === null) {
      return rankCommands(commands, query.name).map((command) => ({ label: `/${command.name}`, description: describe(command), complete: `/${command.name} ` }))
    }
    const command = commands.find((entry) => entry.name === query.name || entry.aliases.includes(query.name))
    if (!command || command.subcommands.length === 0) return []
    return command.subcommands
      .filter((sub) => sub.toLowerCase().startsWith(query.arg ?? ''))
      .slice(0, MAX_ITEMS)
      .map((sub) => ({ label: `/${command.name} ${sub}`, description: '', complete: `/${command.name} ${sub} ` }))
  }, [query?.name, query?.arg, commands, dismissedFor, input])

  useEffect(() => {
    setSelected(0)
  }, [query?.name, query?.arg])

  const index = Math.min(selected, Math.max(0, candidates.length - 1))
  const state: SlashPickerState | null = candidates.length === 0
    ? null
    : {
        visible: true,
        items: candidates.map((candidate, at): PickerItem => ({ id: candidate.label, label: candidate.label, description: candidate.description, selected: at === index })),
      }

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (candidates.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSelected((current) => (Math.min(current, candidates.length - 1) + step + candidates.length) % candidates.length)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissedFor(input)
      return true
    }
    const choice = candidates[index]!
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      setInputText(choice.complete)
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      // The draft already IS this command: run it (normal submit path).
      if (input.trim() === choice.complete.trim()) return false
      event.preventDefault()
      setInputText(choice.complete)
      return true
    }
    return false
  }, [candidates, index, input, setInputText])

  return { state, onKeyDown }
}
