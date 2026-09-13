import { useState, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { createRoot, type Root } from 'react-dom/client'
import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { viewComponentFor } from '@renderer/apps/host/viewBridge'
import { ThemePickerRow } from '@renderer/features/settings/ui/ThemePickerRow'

let root: Root | undefined
const messages: Array<Record<string, unknown>> = []
window.addEventListener('message', event => {
  const frame = document.querySelector('iframe')
  if (event.source !== frame?.contentWindow || !event.origin.startsWith('agent-code-ext://')) return
  if (event.data?.kind?.startsWith('fixture:')) messages.push(event.data)
})

let selectedPane = 'previous'
let resetSelection = () => {}
function KeyboardFixture({ render }: { render: (focus: () => void, focused: boolean) => ReactNode }) {
  const [selected, setSelected] = useState('previous')
  selectedPane = selected
  resetSelection = () => setSelected('previous')
  const tab = { id: 'fixture-tab', title: 'Fixture', focusedSessionId: selected,
    root: { type: 'split', direction: 'horizontal', ratio: 0.5,
      a: { type: 'leaf', sessionId: 'previous' }, b: { type: 'leaf', sessionId: 'extension' } } }
  // Only workspace data is fixture-owned. Use the real global keyboard router
  // and store invocation queue, so native forwarding cannot pass by calling a
  // test-only command handler that skips focus/context/override behavior.
  const workspace = { state: { activeTabId: tab.id, tabs: [tab],
    sessions: { previous: { kind: 'terminal' }, extension: { kind: 'extension-view' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [], gridRelatedSelections: {}, dispatchMode: null },
    activeTab: tab, dispatchMode: null, readerMode: null, spotlight: null, tileTabs: null, runtimes: {},
  } as unknown as Workspace
  useKeybinds(workspace)
  return render(() => setSelected('extension'), selected === 'extension')
}
useAppStore.subscribe(state => state.pendingCommandInvocation, command => {
  if (command) messages.push({ kind: 'fixture:command', command: command.id, selected: selectedPane })
})

const harness = {
  async showThemes() {
    root?.unmount()
    messages.length = 0
    useAppStore.getState().setInstalledExtensions(await window.api.extensionsList())
    function Picker() {
      const settings = useAppStore(state => state.settings)
      return <ThemePickerRow settings={settings} onSelect={mode => useAppStore.getState().setSettings({ mode })} onCreate={() => {}} onEdit={() => {}} onDelete={() => {}} />
    }
    root = createRoot(document.getElementById('host')!)
    root.render(<Picker />)
  },
  chooseTheme() {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Counter Night'))
    if (!button) throw new Error('The installed SDK theme is missing from the picker')
    button.click()
  },
  async refreshThemes() { useAppStore.getState().setInstalledExtensions(await window.api.extensionsList()) },
  themeSnapshot() { return { mode: useAppStore.getState().settings.mode, canvas: getComputedStyle(document.documentElement).getPropertyValue('--theme-canvas').trim(), appliedMode: document.documentElement.dataset.mode } },
  async render(id: string, themeDelay: number, themeFailure = false, viewId = `${id}.main`, modal = false, liveTheme = false) {
    root?.unmount()
    messages.length = 0
    const entries = await window.api.extensionsList()
    useAppStore.getState().setInstalledExtensions(entries)
    const entry = entries.find(candidate => candidate.manifest.id === id)
    if (!entry) throw new Error(`Fixture ${id} is not installed`)
    const api = createAppHostApi({ extensionId: id, showToast: () => {}, closeSurface: () => { root?.unmount(); root = undefined; messages.push({ kind: 'fixture:close' }) } })
    const View = viewComponentFor(entry, viewId, !modal)
    root = createRoot(document.getElementById('host')!)
    root.render(<KeyboardFixture render={(onFocus, focused) => {
      const view = <View onFocus={modal ? undefined : onFocus} focused={modal ? undefined : focused} api={{ ...api, theme: { tokens: async () => {
        await new Promise(resolve => setTimeout(resolve, themeDelay))
        if (themeFailure) throw new Error('fixture theme unavailable')
        if (liveTheme) return api.theme.tokens()
        return { '--theme-canvas': 'rgb(1, 2, 3)' }
      } } }} />
      return modal ? <Dialog open><DialogContent><DialogTitle>Extension input fixture</DialogTitle>{view}</DialogContent></Dialog> : view
    }} />)
  },
  resetInput() { messages.length = 0; resetSelection(); useAppStore.getState().clearCommandInvocation() },
  rebindPalette() { useAppStore.setState(state => ({ settings: { ...state.settings, commandKeybindingOverrides: { 'open-command-palette': ['Ctrl+Shift+K'] } } })) },
  unmount() { root?.unmount(); root = undefined; messages.length = 0 },
  snapshot() { return { text: document.body.innerText, src: document.querySelector('iframe')?.getAttribute('src') ?? null, failures: useAppStore.getState().extensionFailures, messages: [...messages] } },
  retry() {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('Retry'))
    if (!button) throw new Error('No retry button is visible')
    button.click()
  },
}
Object.assign(window, { fixtureHarness: harness })
