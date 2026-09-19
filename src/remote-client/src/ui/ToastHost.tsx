import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// Phone toast host — the phone-side counterpart of @renderer/ui/GlobalToast,
// aliased over it in vite.config.ts (see the stub table there).
//
// WHY the phone needs its own module instead of mounting the desktop
// provider: the desktop GlobalToastProvider reads `useAppStore` (extension
// catalog) and subscribes `window.api.onExtensionNotification` — neither
// exists in a phone browser. More importantly, WITHOUT any provider the
// shared rows' `useGlobalToast()` resolves to the desktop module's no-op
// default context, so an AskUserQuestion answer failure
// (AskUserQuestionRow's "Could not send your answer: …") vanished without a
// trace on the phone — the exact silent-failure class this host exists to
// close.
//
// The PUBLIC API is deliberately identical to the desktop module
// (`showToast(message, durationMs?)`) so every shared row keeps importing
// `@renderer/ui/GlobalToast` unchanged and simply works here.
//
// Presentation differs where the device differs: the desktop anchors
// top-right (mouse-corner, z-[1200] above dialog scrims); a phone anchors
// BOTTOM — above the composer, inside the safe-area — because the user's
// thumb and eyes are already there mid-interaction. It keeps `rounded-float`
// (a toast is the definition of a detached surface; hard rule 1 sanctions
// rounding here on both devices) and the single-slot, auto-dismiss,
// tap-to-dismiss behavior of the desktop toast.

type GlobalToastContextValue = {
  showToast: (message: string, durationMs?: number) => void
}

const GlobalToastContext = createContext<GlobalToastContextValue>({
  showToast: () => {},
})

export function useGlobalToast(): GlobalToastContextValue {
  return useContext(GlobalToastContext)
}

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
