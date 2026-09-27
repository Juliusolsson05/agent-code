import type { ReactNode } from 'react'

/**
 * The header shared by the debug-family side panels (#512): a red uppercase
 * title, optional actions, and one close.
 *
 * WHY its own header and not PanelHeader: these are diagnostic tools, and the
 * red title is the deliberate cue that the panel reads raw session state
 * rather than being product UI (ProxyDebugPanel's note). What they must share
 * with PanelHeader is a close with an accessible name: all five copies of
 * this header drew a bare "×" that a screen reader announced as nothing.
 */
export function DebugPanelHeader({
  title,
  closeLabel,
  actions,
  onClose,
}: {
  title: ReactNode
  /** Accessible name of the close button ("Close debug logs"). */
  closeLabel: string
  actions?: ReactNode
  onClose: () => void
}) {
  return (
    <div className="
      flex items-center justify-between
      px-3 py-2 border-b border-border
      text-[9px] text-danger uppercase tracking-wider
      select-none flex-shrink-0
    ">
      <span>{title}</span>
      <div className="flex items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title="Close"
          className="text-muted hover:text-ink text-[14px] leading-none"
        >
          ×
        </button>
      </div>
    </div>
  )
}
