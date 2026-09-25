import { useEffect } from 'react'

import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { useCaffeinateStore } from '../store'

// Caffeinate feedback (#494 — was inline App.tsx JSX), shown through the ONE
// app toast surface.
//
// WHY this no longer draws its own toast (keyboard-first plan, UI pass): it
// was a second toast look (bottom-right card, z-50) beside GlobalToast
// (top-right, z-[1200]). z-50 painted it UNDER every dialog scrim (z-[1100]),
// so a caffeinate message raised while a dialog was open, such as a toggle
// from the command palette or an auto-stop, was hidden for its whole
// lifetime. It also mounted its `role="status"` together with its text, which
// screen readers do not announce; GlobalToast's region is always mounted
// (plan N17). Handing the text to GlobalToast fixes both and leaves the app
// one toast.
//
// The store's `message` stays the source of truth (the palette and the
// settings bar write it). This surface is the adapter that forwards each new
// message once and then clears it, so the same text re-raised later still
// shows.
export function CaffeinateToastSurface() {
  const message = useCaffeinateStore(state => state.message)
  const dismissMessage = useCaffeinateStore(state => state.dismissMessage)
  const { showToast } = useGlobalToast()

  useEffect(() => {
    if (!message) return
    // 5 s, the duration this surface always used: caffeinate messages carry
    // a reason ("stopped: …") worth reading, longer than the 2.5 s default.
    showToast(`Caffeinate: ${message}`, 5000)
    dismissMessage()
  }, [dismissMessage, message, showToast])

  return null
}
