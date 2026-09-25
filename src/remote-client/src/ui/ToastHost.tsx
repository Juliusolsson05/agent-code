import { useCallback, useEffect, useRef, useState } from 'react'

import { GlobalToastContext } from '@renderer/ui/GlobalToastContext'

// Phone toast host — the phone's PRESENTATION of the one shared toast
// contract (@renderer/ui/GlobalToastContext, #1177).
//
// WHY the phone does not mount the desktop provider: GlobalToastProvider
// reads `useAppStore` (extension catalog) and subscribes
// `window.api.onExtensionNotification` — neither exists in a phone browser.
// Until #1177 this file was aliased over the desktop module and re-declared
// its own look-alike context; now it simply PROVIDES the shared context, so
// every row's `useGlobalToast()` reaches it with no alias. Without a provider
// the context's no-op default would swallow an AskUserQuestion answer
// failure ("Could not send your answer: …") — the silent-failure class this
// host exists to close.
//
// Presentation differs where the device differs: the desktop anchors
// top-right (mouse-corner, z-[1200] above dialog scrims); a phone anchors
// BOTTOM — above the composer, inside the safe-area — because the user's
// thumb and eyes are already there mid-interaction. It keeps `rounded-float`
// (a toast is the definition of a detached surface; hard rule 1 sanctions
// rounding here on both devices) and the single-slot, auto-dismiss,
// tap-to-dismiss behavior of the desktop toast.

export function ToastHostProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string, durationMs = 2500) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast(message)
    timerRef.current = setTimeout(() => {
      setToast(null)
      timerRef.current = null
    }, durationMs)
  }, [])

  useEffect(
    () => () => {
      // Unmount with a pending timer would fire setState on a dead tree —
      // harmless in React 18 but the timer still belongs to whoever armed it.
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setToast(null)
  }, [])

  return (
    <GlobalToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          onClick={dismiss}
          role="status"
          title="Dismiss"
          className="
            fixed bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] left-3 right-3 z-[1200]
            toast-enter
            cursor-pointer
            bg-accent/80 border border-accent/40 rounded-float
            shadow-lg shadow-black/20
            px-4 min-h-[44px] flex items-center
            text-[12px] font-code text-white font-semibold
          "
        >
          {toast}
        </div>
      )}
    </GlobalToastContext.Provider>
  )
}
