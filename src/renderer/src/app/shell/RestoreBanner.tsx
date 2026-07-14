import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// WHY render this above TabBar instead of as a toast:
//
// The state being communicated is durable for the lifetime of the app
// run, not a transient event — autosave is disabled until the user
// restarts the app, so dismissing a toast would orphan the warning
// while the underlying disk-protection invariant is still in effect.
// A persistent banner above the tab bar matches how Electron desktop
// apps surface "this run is degraded" state (e.g. update available),
// and the user sees it on every interaction instead of having to
// remember a toast they swatted at boot.
export function RestoreBanner() {
  const workspace = useWorkspaceContext()
  const message: string | null =
    workspace.restoreStatus === 'partial-restore'
      ? 'Workspace partially restored — autosave is disabled to protect your saved state. Restart Agent Code after fixing the underlying spawn or proxy issue.'
      : workspace.restoreStatus === 'persisted-fallback'
        ? 'Could not load your saved workspace — running in a fresh-tab fallback. Autosave is disabled to avoid overwriting the on-disk file. Restart after resolving the issue.'
        : workspace.restoreStatus === 'bootstrap-error'
          ? 'Workspace bootstrap failed. Autosave is disabled. Check the dev console and restart Agent Code after fixing the underlying issue.'
          : null
  if (!message) return null
  return (
    <div
      role="alert"
      className="
        flex items-start gap-3 px-3 py-2
        border-b border-warning bg-warning/15 text-warning
        text-[11px] leading-snug font-code
        flex-shrink-0
      "
    >
      <span className="font-semibold uppercase tracking-wide">Autosave off</span>
      <span className="text-ink/90">{message}</span>
    </div>
  )
}
