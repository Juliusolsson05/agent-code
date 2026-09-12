import { ipcMain, type WebContents } from 'electron'
import { keybindingFromEvent, tryNormalizeKeybinding } from '@shared/keybindings.js'
import type { ExtensionInputBindings, ExtensionNativeInput } from '@shared/types/extensionInput.js'

// Main only captures chords the trusted application router says it owns. It
// cannot ask that renderer asynchronously whether to preventDefault: Chromium
// and native menu actions would already have run (Cmd+W can close the window).
// Actual command selection stays in the existing context-aware renderer router.
export function registerExtensionInputIpc(isApplicationContents: (contents: WebContents) => boolean, onBindings?: (owner: number, bindings: readonly string[]) => void): () => void {
  const owners = new Map<number, { bindings: Set<string>; modalBindings: Set<string>; dispose(): void }>()
  ipcMain.handle('extensions:input-bindings', (event, raw: unknown) => {
    const contents = event.sender
    if (!isApplicationContents(contents) || event.senderFrame !== contents.mainFrame) throw new Error('Native extension input requires an application main frame.')
    const config = raw as ExtensionInputBindings | null
    const valid = (values: unknown): values is string[] => Array.isArray(values) && values.length <= 4096 && values.every(value => typeof value === 'string' && value.length <= 96 && tryNormalizeKeybinding(value) === value)
    if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['pane', 'modal'].includes(key)) || !valid(config.pane) || !valid(config.modal)) {
      throw new Error('Invalid extension input bindings.')
    }
    let owner = owners.get(contents.id)
    if (!owner) {
      const pressed = new Set<string>()
      const focusedUrl = () => {
        if (contents.isDestroyed() || !isApplicationContents(contents)) return null
        const frame = contents.focusedFrame
        if (!frame || frame.parent !== contents.mainFrame) return null
        try {
          const url = new URL(frame.url)
          if (url.protocol !== 'agent-code-ext:' || !url.pathname.endsWith('/__agent-code-frame__.html') || !url.searchParams.get('instance')) return null
          return frame.url
        } catch { return null }
      }
      const send = (message: ExtensionNativeInput) => contents.send('extensions:native-input', message)
      const key = (event: Electron.Event, input: Electron.Input) => {
        if (event.defaultPrevented || input.isComposing) return
        const url = focusedUrl()
        if (!url) { if (input.type === 'keyUp') pressed.delete(input.code); return }
        const value = { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control,
          altKey: input.alt, shiftKey: input.shift, repeat: !!input.isAutoRepeat, isComposing: !!input.isComposing }
        const binding = keybindingFromEvent(value)
        // A modal owns editing and blocks hidden workspace mutations. Capture
        // only its palette/close access; Option composition and native editing
        // remain in the author's document. The parent verifies this exact URL.
        const bindings = new URL(url).searchParams.get('shell') === 'modal' ? owner!.modalBindings : owner!.bindings
        const release = input.type === 'keyUp' && (pressed.has(input.code) || (pressed.size > 0 && ['Meta', 'Control', 'Alt', 'Shift'].includes(input.key)))
        if (input.type === 'keyDown' ? !binding || !bindings.has(binding) : !release) return
        if (input.type === 'keyDown') pressed.add(input.code)
        else pressed.delete(input.code)
        // DOM-dispatched KeyboardEvents do not enter this hook. Neither child
        // postMessage nor a claimed isTrusted flag can manufacture this authority.
        event.preventDefault()
        send({ kind: 'key', url, type: input.type === 'keyDown' ? 'keydown' : 'keyup', input: value })
      }
      const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
        if (input.type !== 'mouseDown') return
        // A repeated click within an already focused iframe does not blur the
        // parent again. Correct workspace selection even in that case; first
        // entry is also covered by the parent's activeElement/blur observation.
        const url = focusedUrl()
        if (url) send({ kind: 'focus', url })
      }
      const navigate = (_event: Electron.Event, _url: string, sameDocument: boolean, main: boolean) => {
        if (main && !sameDocument) { owner!.bindings.clear(); owner!.modalBindings.clear(); pressed.clear() }
      }
      const close = () => owner!.dispose()
      owner = { bindings: new Set(), modalBindings: new Set(), dispose() {
        contents.removeListener('before-input-event', key)
        contents.removeListener('before-mouse-event', mouse)
        contents.removeListener('did-start-navigation', navigate)
        contents.removeListener('destroyed', close)
        owners.delete(contents.id)
      } }
      owners.set(contents.id, owner)
      contents.on('before-input-event', key)
      contents.on('before-mouse-event', mouse)
      contents.on('did-start-navigation', navigate)
      contents.once('destroyed', close)
    }
    owner.bindings = new Set(config.pane)
    owner.modalBindings = new Set(config.modal)
    onBindings?.(contents.id, config.pane)
  })
  return () => {
    ipcMain.removeHandler('extensions:input-bindings')
    for (const owner of owners.values()) owner.dispose()
  }
}
