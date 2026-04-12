import { createContext, useCallback, useContext, useRef, useState } from 'react'

// GlobalToast — app-wide toast system rendered in the top-right corner.
//
// Infrastructure only for now — nothing triggers it yet. The intent is
// tab-scoped notifications that aren't tied to a specific pane (e.g.
// "Session resumed", "Connection lost"). Pane-specific feedback like
// "Copied to clipboard" uses the per-pane toast in TileLeaf instead.
//
// Single-slot, auto-dismiss, same pattern as the pane toast in
// workspaceStore. New toast replaces any in-flight one.

type GlobalToastContextValue = {
  showToast: (message: string, durationMs?: number) => void
}

const GlobalToastContext = createContext<GlobalToastContextValue>({
  showToast: () => {},
})

export const useGlobalToast = () => useContext(GlobalToastContext)

export function GlobalToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const showToast = useCallback((message: string, durationMs = 2500) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast(message)
    timerRef.current = setTimeout(() => {
      setToast(null)
      timerRef.current = null
    }, durationMs)
  }, [])

  return (
    <GlobalToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div className="
          fixed top-3 right-3 z-50
          toast-enter
          bg-accent/80 border border-accent/40
          shadow-lg shadow-black/20
          px-4 py-2
          text-[12px] font-code text-white font-semibold
        ">
          {toast}
        </div>
      )}
    </GlobalToastContext.Provider>
  )
}
