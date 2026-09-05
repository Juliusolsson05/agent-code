import { afterEach, describe, expect, it } from 'vitest'
import { documentationCapabilities } from './documentation'
import { commandControlCapabilities } from '@renderer/features/command-palette/control'
import { keybindingControlCapabilities, keybindingReference } from '@renderer/features/command-keybindings/control'
import { useAppStore } from '@renderer/app-state/store'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { rankCommands } from '@renderer/features/command-palette/lib/rankCommands'
import type { RegisteredCapability } from '@control-sdk'

const original = useAppStore.getState()
afterEach(() => useAppStore.setState(original, true))
const context = { requestId: 'reference', caller: { kind: 'application' as const, id: 'test' }, owner: { kind: 'window' as const, windowId: 'test', generation: 'first' } }

function find(capabilities: RegisteredCapability[], id: string) {
  const capability = capabilities.find(entry => entry.descriptor.id === id)
  if (!capability) throw new Error(`Missing capability ${id}`)
  return capability
}

describe('control discovery against the real app catalog and settings', () => {
  it('retrieves the entire full guide through one tool, including a late feature section', async () => {
    const capability = find(documentationCapabilities(), 'app.describe')
    const first = await capability.execute({ mode: 'full', limit: 3 }, context)
    if (!first.ok) throw new Error(first.error.message)
    let page = first.value as { items: Array<{ id: string }>; nextCursor: string | null; total: number; complete: boolean }
    const ids: string[] = []
    while (true) {
      ids.push(...page.items.map(item => item.id))
      if (!page.nextCursor) break
      const next = await capability.execute({ mode: 'full', limit: 3, cursor: page.nextCursor }, context)
      if (!next.ok) throw new Error(next.error.message)
      page = next.value as typeof page
    }
    expect(ids).toContain('feature:worktrees')
    expect(new Set(ids).size).toBe(page.total)
    expect(page.complete).toBe(true)
    const section = await capability.execute({ section: 'feature:worktrees' }, context)
    expect(section).toMatchObject({ ok: true, value: { total: 1, items: [{ id: 'feature:worktrees' }] } })
    const crashCourse = await capability.execute({}, context)
    expect(crashCourse).toMatchObject({ ok: true, value: { mode: 'crash_course', complete: true } })
  })

  it('retains hidden and unbound commands and invalidates a page when a real setting changes', async () => {
    const commandId = 'new-tab'
    const { settings } = useAppStore.getState()
    useAppStore.setState({ settings: { ...settings, commandVisibilityOverrides: { [commandId]: false }, commandKeybindingOverrides: { [commandId]: [] } } })
    const capabilities = commandControlCapabilities()
    const described = await find(capabilities, 'commands.describe').execute({ commandId }, context)
    expect(described).toMatchObject({ ok: true, value: { id: commandId, visibleInPicker: false, bindings: [] } })
    const listed = await find(capabilities, 'commands.list').execute({ limit: 1 }, context)
    if (!listed.ok) throw new Error(listed.error.message)
    const page = listed.value as { total: number; nextCursor: string }
    expect(page.total).toBe(builtInCommandCatalog.length)
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, commandKeybindingOverrides: { [commandId]: ['Cmd+Alt+T'] } } })
    const stale = await find(capabilities, 'commands.list').execute({ limit: 1, cursor: page.nextCursor }, context)
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_cursor', outcome: 'not_started' } })
  })

  it('keeps explicit unbinding, inherited defaults, unknown saved entries and mouse configuration distinct', async () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings,
      commandKeybindingOverrides: { 'new-tab': [], 'temporarily-uninstalled-command': ['Alt+X'] },
      paletteMouseChord: 'Middle+Right',
    } })
    const bindings = keybindingReference()
    expect(bindings.find(entry => entry.id === 'new-tab')).toMatchObject({ bindings: [], defaults: ['Cmd+T'], customized: true })
    expect(bindings.find(entry => entry.id === 'temporarily-uninstalled-command')).toMatchObject({ bindings: ['Alt+X'], customized: true })
    expect(bindings.find(entry => entry.id === 'palette.mouse')).toMatchObject({ inputType: 'mouse', bindings: ['Middle+Right'], configuredEnabled: true })
    const page = await keybindingControlCapabilities()[0].execute({ query: 'Middle+Right' }, context)
    expect(page).toMatchObject({ ok: true, value: { items: [{ id: 'palette.mouse' }] } })
  })

  it('uses the same description match in picker and control search without defeating title priority', async () => {
    // Actual shipped descriptions, not invented search examples. A complete
    // description is deliberately outside the title/keyword path.
    const command = builtInCommandCatalog.find(entry => entry.id === 'toggle-reader-mode')!
    const query = command.description
    const result = await commandControlCapabilities()[0].execute({ query }, context)
    if (!result.ok) throw new Error(result.error.message)
    expect((result.value as { items: Array<{ id: string }> }).items.map(item => item.id)).toContain(command.id)
    const resolved = builtInCommandCatalog.map(entry => ({ ...entry, title: typeof entry.title === 'string' ? entry.title : entry.id, keywords: entry.keywords ?? [], state: null, keepPaletteOpen: false }))
    expect(rankCommands(resolved, query, new Map(), {}).commands.map(entry => entry.id)).toContain(command.id)
    const exactTitle = typeof command.title === 'string' ? command.title : command.id
    expect(rankCommands(resolved, exactTitle, new Map(), {}).commands[0].id).toBe(command.id)
  })
})
