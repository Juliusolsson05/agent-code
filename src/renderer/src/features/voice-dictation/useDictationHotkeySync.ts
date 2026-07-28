import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { setKeyboardDictationHoldStyle } from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'

// Root effect extracted from App.tsx (#494).
export function useDictationHotkeySync(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  const { showToast } = useGlobalToast()
  useEffect(() => {
    // The default dictation trigger is bare Fn, which Chromium does not expose
    // reliably to renderer keydown. Settings live in the renderer, but the
    // actual capture must live in main/native; keep this one-way sync here so
    // every pane shares the same OS listener while the focused pane decides
    // whether to consume the resulting press/release event.
    const binding = dictationEnabled ? dictationShortcut : ''
    void window.api.configureDictationHotkey({ binding }).then(result => {
      // Main is the only place that knows which path claimed the binding, and
      // the two have different gestures: the CGEventTap helper (`native`)
      // emits real press/release edges and is hold-to-talk, while the quiet
      // globalShortcut path has no key-up callback and can only toggle. The
      // overlay's instruction text depends on this, so record it centrally
      // instead of re-deriving it from the binding string (which cannot tell
      // a bare `Cmd` native hold from a `Cmd+Shift+D` toggle).
      setKeyboardDictationHoldStyle(result.native ? 'hold' : 'toggle')
      if (!result.ok) {
        console.warn('[dictation] hotkey registration failed:', result)
        // The whole point of #495 A4 / #508 is that this failure must be
        // VISIBLE: main already journals it and returns the actionable
        // reason on the configure result, but a packaged user never sees a
        // console.warn — the toast is the only surface they actually look
        // at. Long duration + click-to-dismiss because the message carries
        // a fix ("grant Accessibility permission…", "xcode-select
        // --install") the user needs time to read. No re-toast loop risk:
        // this effect fires only on settings changes, not on a poll.
        showToast(
          `Dictation hotkey unavailable: ${result.message ?? `could not register "${result.binding}"`}`,
          12000,
        )
      }
    })
  }, [dictationEnabled, dictationShortcut, showToast])
}
