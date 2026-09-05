import { z } from 'zod'
import { ControlError, defineCapability, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'

const identity = { sessionId: z.string().min(1).describe('Stable agent sessionId from agents.search/list.') }
const imageReference = z.object({ id: z.string(), filename: z.string(), mediaType: z.string() })
const summary = z.object({ sessionId: z.string(), revision: z.string(), totalChars: z.number(), images: z.array(imageReference) })

export function draftControlCapabilities(getWorkspace: () => Workspace) {
  const current = (sessionId: string) => {
    const store = useAppStore.getState()
    const meta = store.workspaceState.sessions[sessionId]
    if (!meta || meta.kind === 'terminal' || store.workspaceState.buried.some(item => item.sessionId === sessionId)) {
      throw new ControlError('unavailable', 'Choose a current, non-buried agent')
    }
    const runtime = store.workspaceRuntimes[sessionId] ?? emptyRuntime()
    const images = runtime.draftImages.map(({ id, filename, mediaType }) => ({ id, filename, mediaType }))
    // Attachments have immutable IDs. Include their ordered identities and the
    // complete text, not streaming runtime timestamps or a React render count:
    // new assistant tokens must not invalidate an unrelated composer edit.
    const revision = paginate([{ text: runtime.draftInput, images }], { limit: 1 }, `draft:${sessionId}`).revision
    return { runtime, summary: { sessionId, revision, totalChars: runtime.draftInput.length, images } }
  }
  return [
    defineCapability({
      id: 'agents.draftGet', title: 'Read an agent composer draft', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Read unsent composer text and attachment references without waking the agent. Includes a content revision for safe edits. Large drafts page by UTF-16 offset; keep the returned revision while continuing. No attachment binary data is returned.',
      input: z.object({ ...identity, offset: z.number().int().min(0).default(0).describe('UTF-16 nextOffset from the previous page; starts at zero.'),
        revision: z.string().optional().describe('Revision from the first page; required when offset is nonzero.'),
        maxChars: z.number().int().min(256).max(262144).default(24000).describe('Maximum UTF-16 code units per page.') }).strict(),
      output: summary.extend({ text: z.string(), offset: z.number(), nextOffset: z.number().nullable() }),
      handler: input => {
        const { runtime, summary } = current(input.sessionId)
        if ((input.offset > 0 && !input.revision) || (input.revision && input.revision !== summary.revision)) throw new ControlError('stale_cursor', 'Draft changed or revision is missing; read again from offset zero')
        if (input.offset > runtime.draftInput.length) throw new ControlError('invalid_cursor', 'Offset exceeds the draft')
        // Do not split a surrogate pair, even though offsets use JS string
        // units. Each page must remain valid JSON and concatenate losslessly.
        let end = Math.min(runtime.draftInput.length, input.offset + input.maxChars)
        if (end < runtime.draftInput.length && /[\uD800-\uDBFF]/.test(runtime.draftInput[end - 1])) end--
        return { ...summary, text: runtime.draftInput.slice(input.offset, end), offset: input.offset, nextOffset: end < runtime.draftInput.length ? end : null }
      },
    }),
    defineCapability({
      id: 'agents.draftSet', title: 'Edit an agent composer draft', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Replace unsent draft text, clear text and attachments, or undo the last clear through the normal composer operations. Requires the current draftGet revision so concurrent human edits are not overwritten. Replacing text preserves images; undo restores text only and swaps any intervening text. Never sends a prompt or wakes an agent.',
      input: z.object({ ...identity, revision: z.string().describe('Current revision from agents.draftGet; required even for clear/undo.'), change: z.discriminatedUnion('action', [
        z.object({ action: z.literal('replace'), text: z.string().max(1048576).describe('Complete replacement text, not a patch. Existing images remain attached.') }).strict(),
        z.object({ action: z.literal('clear') }).strict(),
        z.object({ action: z.literal('undo-clear') }).strict(),
      ]) }).strict(),
      output: summary.extend({ changed: z.boolean() }),
      handler: input => {
        if (getWorkspace().restoreStatus === 'pending') throw new ControlError('unavailable', 'Wait for workspace restoration')
        const before = current(input.sessionId)
        if (before.summary.revision !== input.revision) throw new ControlError('stale_cursor', 'Draft changed; read it again before editing')
        // There is deliberately no await between comparison and the existing
        // setter. Zustand applies this synchronously, including draftVersion
        // persistence notifications owned by useDraftActions.
        if (input.change.action === 'replace') getWorkspace().setDraftInput(input.sessionId, input.change.text)
        else if (input.change.action === 'clear') getWorkspace().clearDraft(input.sessionId)
        else getWorkspace().undoClearDraft(input.sessionId)
        const after = current(input.sessionId).summary
        return { ...after, changed: before.summary.revision !== after.revision }
      },
    }),
  ]
}
