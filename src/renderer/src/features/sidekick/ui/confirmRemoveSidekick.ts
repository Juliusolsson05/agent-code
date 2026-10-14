import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'

/**
 * Ask, then remove a sidekick. Shared by the picker (⌘⌫) and the strip's
 * right-click menu so the two places that can destroy a sidekick say exactly
 * the same thing. Before this helper the panel header and the picker each
 * carried a copy of the dialog copy, and a wording fix had to find both.
 *
 * Errors are reported through the caller's toast rather than thrown: both
 * callers are fire-and-forget UI handlers with nothing to unwind.
 */
export async function confirmRemoveSidekick(
  actions: Pick<SidekickActions, 'removeSidekick'>,
  sidekickId: string,
  showToast: (message: string) => void,
): Promise<void> {
  const confirmed = await requestConfirm({
    title: 'Remove Sidekick',
    description: 'Its process stops and it leaves the Sidekick index. The conversation stays in Conversations.',
    confirmLabel: 'Remove',
    tone: 'danger',
  })
  if (!confirmed) return
  try {
    await actions.removeSidekick(sidekickId)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  }
}
