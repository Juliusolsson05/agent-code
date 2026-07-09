import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Root effect extracted from App.tsx (#494).
export function useDictationHotkeySync(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  useEffect(() => {
    // The default dictation trigger is bare Fn, which Chromium does not expose
    // reliably to renderer keydown. Settings live in the renderer, but the
    // actual capture must live in main/native; keep this one-way sync here so
    // every pane shares the same OS listener while the focused pane decides
    // whether to consume the resulting press/release event.
    const binding = dictationEnabled ? dictationShortcut : ''
    void window.api.configureDictationHotkey({ binding }).then(result => {
      if (!result.ok) {
        console.warn('[dictation] hotkey registration failed:', result)
      }
    })
  }, [dictationEnabled, dictationShortcut])
}
