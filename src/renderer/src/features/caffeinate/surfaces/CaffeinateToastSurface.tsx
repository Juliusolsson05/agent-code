import { useEffect } from 'react'
import { useCaffeinateStore } from '../store'

// Transient caffeinate feedback toast (#494 — was inline App.tsx JSX).
// The 5s auto-dismiss timer lives HERE rather than in the composition
// root because it is the toast's lifecycle, not the app's: whoever
// renders the message owns forgetting it.
export function CaffeinateToastSurface() {
  const message = useCaffeinateStore(state => state.message)
  const dismissMessage = useCaffeinateStore(state => state.dismissMessage)

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => dismissMessage(), 5000)
    return () => window.clearTimeout(timer)
  }, [dismissMessage, message])

  if (!message) return null
  return (
    <div
      role="status"
      className="
        fixed bottom-3 right-3 z-50 max-w-[360px]
        border border-border bg-surface-hi px-3 py-2
        text-[11px] leading-snug text-ink shadow-lg
      "
    >
      <div className="font-semibold uppercase tracking-wide text-muted">
        Caffeinate
      </div>
      <div>{message}</div>
    </div>
  )
}
