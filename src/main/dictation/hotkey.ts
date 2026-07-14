import { globalShortcut } from 'electron'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import { startMacDictationHotkeyHelper, stopMacDictationHotkeyHelper } from '@main/dictation/macHotkeyHelper.js'

let currentBinding = ''
let registeredElectronHotkey = ''

export async function configureDictationHotkey(binding: string): Promise<{
  ok: boolean
  binding: string
  native: boolean
  /** Failure reason from the native-helper layer (#495 A4) — e.g. "Xcode
   *  Command Line Tools not installed" in dev, or "bundled helper binary
   *  missing" in a packaged build. Rides the existing
   *  DictationHotkeyConfigureResult ok:false arm; absent on success. */
  message?: string
}> {
  currentBinding = binding.trim()
  if (registeredElectronHotkey) {
    globalShortcut.unregister(registeredElectronHotkey)
    registeredElectronHotkey = ''
  }
  stopMacDictationHotkeyHelper()

  if (!currentBinding) return { ok: true, binding: currentBinding, native: false }

  if (process.platform === 'darwin') {
    // Bare Fn is the default product trigger and Chromium does not reliably
    // expose it to renderer keydown. Route every macOS dictation binding
    // through the same CGEventTap helper as the standalone app so the default,
    // bare modifiers, and normal key chords all have one press/release model.
    const result = await startMacDictationHotkeyHelper(currentBinding, {
      onPress: () => {
        // Press/release bugs are catastrophic for hold-to-talk: one missed
        // release leaves the composer "listening" forever. Keep this trace in
        // main so we can distinguish native-helper problems from renderer
        // lifecycle problems without guessing from Deepgram logs.
        // eslint-disable-next-line no-console
        console.debug('[dictation:hotkey] down', { binding: currentBinding, at: Date.now() })
        sendToMainWindow('dictation:hotkey-down', { binding: currentBinding })
      },
      onRelease: () => {
        // eslint-disable-next-line no-console
        console.debug('[dictation:hotkey] up', { binding: currentBinding, at: Date.now() })
        sendToMainWindow('dictation:hotkey-up', { binding: currentBinding })
      },
    })
    return {
      ok: result.ok,
      binding: currentBinding,
      native: true,
      ...(result.message ? { message: result.message } : {}),
    }
  }

  try {
    const ok = globalShortcut.register(currentBinding, () => {
      sendToMainWindow('dictation:hotkey-down', { binding: currentBinding })
      sendToMainWindow('dictation:hotkey-up', { binding: currentBinding })
    })
    if (ok) registeredElectronHotkey = currentBinding
    return { ok, binding: currentBinding, native: false }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[dictation:hotkey] invalid Electron accelerator "${currentBinding}"`, err)
    return { ok: false, binding: currentBinding, native: false }
  }
}

export function unregisterDictationHotkey(): void {
  currentBinding = ''
  if (registeredElectronHotkey) {
    globalShortcut.unregister(registeredElectronHotkey)
    registeredElectronHotkey = ''
  }
  stopMacDictationHotkeyHelper()
}
