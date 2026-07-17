import { createContext, useCallback, useContext, useRef, useState } from 'react'

// GlobalToast — app-wide toast system rendered in the top-right corner.
//
// The intent is tab-scoped notifications that aren't tied to a specific
// pane (e.g. "Session resumed", "Connection lost", "dictation hotkey
// unavailable"). Pane-specific feedback like "Copied to clipboard" uses
// the per-pane toast in TileLeaf instead.
//
// Single-slot, auto-dismiss, same pattern as the pane toast in
// workspaceStore. New toast replaces any in-flight one. Also click-to-
// dismiss: warning-grade toasts (hotkey failures) use long durations so
// the user actually sees them, and a 10-second banner you can't get rid
// of reads as broken UI — one click clears it early.

type GlobalToastContextValue = {
  showToast: (message: string, durationMs?: number) => void
}

const GlobalToastContext = createContext<GlobalToastContextValue>({
  showToast: () => {},
})

export function useGlobalToast(): GlobalToastContextValue {
  return useContext(GlobalToastContext)
}

export function GlobalToastProvider({ children }: { children: React.ReactNode }) {
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
          title="Dismiss"
          className="
            fixed top-3 right-3 z-50
            toast-enter
            cursor-pointer
            bg-accent/80 border border-accent/40
            shadow-lg shadow-black/20
            px-4 py-2
            max-w-[420px]
            text-[12px] font-code text-white font-semibold
          "
        >
          {toast}
        </div>
      )}
    </GlobalToastContext.Provider>
  )
}
