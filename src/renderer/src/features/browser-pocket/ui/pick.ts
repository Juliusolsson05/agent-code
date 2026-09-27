import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { formatElementChip, insertAtCaret } from '@shared/browserPocket/elementChip'
import type { PocketPickOutcome } from '@shared/browserPocket/types'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

import type { usePocketLiveStore } from '../state/pocketLiveStore'

type Patch = ReturnType<typeof usePocketLiveStore.getState>['patch']

export const PICK_FAILED: Record<Extract<PocketPickOutcome, { kind: 'failed' }>['reason'], string> = {
  'devtools-open': "Close the pocket's DevTools to pick an element.",
  unavailable: "The browser pocket isn't available for picking right now.",
  error: "Couldn't pick an element. Try again.",
}

/**
 * Pick an element in the pocket and hand it to THIS lane's agent (spec §4.7).
 *
 * The chip goes into this session's composer draft at the caret — never into
 * a new chat (Cursor forum 145968) — and the element's screenshot rides along
 * as a draft image when the provider accepts images. Agents shown as a raw
 * terminal have no composer we own, so the chip goes to the clipboard (D10)
 * rather than being typed into a TUI on the user's behalf.
 */
export async function pickIntoComposer(pocketId: string, sessionId: SessionId, workspace: Workspace, patchLive: Patch, showToast: (m: string) => void): Promise<void> {
  patchLive(pocketId, { picking: true })
  let outcome: PocketPickOutcome
  try {
    outcome = await window.api.pickInPocket({ pocketId })
  } catch {
    outcome = { kind: 'failed', reason: 'error' }
  } finally {
    patchLive(pocketId, { picking: false })
  }
  // A cancel is the user's own choice: silent. A failure used to look the
  // same (#1305), so Pick simply did nothing; it is said now, in fixed words.
  if (outcome.kind === 'cancelled') return
  if (outcome.kind === 'failed') {
    showToast(PICK_FAILED[outcome.reason])
    return
  }
  const result = outcome.result
  const chip = formatElementChip(result)
  const composer = document.querySelector<HTMLTextAreaElement>(`[data-composer-input="${CSS.escape(sessionId)}"]`)
  if (!composer) {
    await navigator.clipboard.writeText(chip).catch(() => {})
    showToast('Element copied — paste it into the agent')
    return
  }
  // A textarea keeps selectionStart after it loses focus, so this is where the
  // user's caret was before they clicked into the page.
  const runtime = workspace.runtimes[sessionId]
  const draft = runtime?.draftInput ?? composer.value
  const { text, caret } = insertAtCaret(draft, composer.selectionStart ?? null, chip)
  workspace.setDraftInput(sessionId, text)
  const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
  if (result.image && isAgentProviderKind(kind) && getRendererProviderCapabilities(kind).supportsImageAttachments) {
    const [, mediaType, base64Data] = /^data:([^;]+);base64,(.*)$/.exec(result.image) ?? []
    if (mediaType && base64Data) {
      workspace.setDraftImages(sessionId, prev => [...prev, {
        id: crypto.randomUUID(), mediaType, base64Data, previewUrl: result.image!, filename: 'picked-element.jpg',
      }])
    }
  }
  requestAnimationFrame(() => {
    composer.focus()
    composer.setSelectionRange(caret, caret)
  })
}
