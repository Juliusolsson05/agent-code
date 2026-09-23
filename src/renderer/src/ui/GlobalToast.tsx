import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { managedSkillsUnavailableMessage } from '@shared/types/tldr'

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
//
// WHY z-[1200] and not z-50: the toast sat below the Radix dialog scrim
// (z-[1100], 88% opaque) so any toast raised while a modal was open was
// washed out to invisibility. That went unnoticed for as long as every caller
// was non-modal chrome — TileLeaf, SafeInlineCode, SafeMarkdownLink. It broke
// the moment extensions started toasting from inside a hosted view, where the
// toast can ONLY fire while a dialog is open, making it hidden 100% of the time.
//
// Raising the toast rather than lowering the dialog is the correct direction: a
// toast is by definition the topmost transient layer, and every existing caller
// is unaffected by it moving up, whereas lowering the dialog would break the
// modal stacking the entire surface registry depends on.

const MANAGED_SKILLS_WARNING_REPEAT_MS = 60_000

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

  useEffect(() => window.api.onExtensionNotification?.(event => {
    // Attribute extension-authored text with host-owned metadata. The id remains
    // a reliable fallback during the short startup window before catalog load.
    const name = useAppStore.getState().installedExtensions
      .find(entry => entry.manifest.id === event.extensionId)?.manifest.name
      ?? event.extensionId
    showToast(`${name}: ${event.message}`, 6000)
  }), [showToast])

  // #1133: a TLDR/Goal skill could not be prepared and agents were launched
  // without it. WHY the global toast and not a pane toast or condition:
  // - The fault is machine-wide skill health, not something one pane did.
  // - Restoring a workspace fires this once per pane. The single slot collapses
  //   fifteen identical warnings into one, where pane toasts would put the
  //   same banner in every pane.
  // - Provider conditions are interactive TUI states with actions. This has
  //   nothing to answer.
  // 10 s and click-to-dismiss follow the warning-grade precedent above: long
  // enough to read the Settings path, and dismissable so it never reads as
  // stuck. The lasting record is the skill's health in Settings, which this
  // text points to.
  //
  // WHY a 60 s repeat window per skill set: main warns on EVERY launch while
  // the skill stays broken (each new pane, orchestration child and wake). The
  // single slot only collapses one restore burst. Without the window, a
  // broken skill re-raised the same 10 s toast all day, pushed out extension
  // notifications that share the slot, and brought back a toast the user had
  // just dismissed mid-burst. The key is the skill SET, so a newly failing
  // skill (TLDR, then TLDR+Goal) still shows at once. Main's journal keeps
  // every occurrence, so nothing diagnostic is lost here. Per window, because
  // every window gets the broadcast and each has its own user-visible slot.
  const lastSkillsWarningRef = useRef<{ key: string; at: number } | null>(null)
  useEffect(() => window.api.onManagedSkillsUnavailable?.(event => {
    const key = [...event.skills].sort().join(',')
    const now = Date.now()
    const last = lastSkillsWarningRef.current
    if (last && last.key === key && now - last.at < MANAGED_SKILLS_WARNING_REPEAT_MS) return
    lastSkillsWarningRef.current = { key, at: now }
    showToast(managedSkillsUnavailableMessage(event.skills), 10_000)
  }), [showToast])

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
            fixed top-3 right-3 z-[1200]
            toast-enter
            cursor-pointer
            bg-accent/80 border border-accent/40 rounded-float
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
