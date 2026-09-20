import { randomUUID } from 'node:crypto'

import type { RewindAttachment } from '@main/providerSwitch/rewindAttachments.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type {
  ListRewindPromptsRequest,
  RewindPrompt,
  RewindPromptAddress,
} from '@shared/types/transcriptRewind.js'
import { rewindConversation } from 'agent-transcript-parser'

import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'

export type RewindSessionRequest = {
  provider: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
  anchor: RewindPromptAddress
}

export type RewindSessionImage = {
  mediaType: string
  data: string
}

/**
 * One attachment's fate, WITHOUT its bytes (#1073 review, finding 3).
 *
 * The restored images already cross this boundary once, in `promptImages`,
 * and the corpus mean is 326k base64 characters with a real 12-image prompt
 * at 2.8 MB. Shipping `promptAttachments` verbatim structured-cloned every one
 * of those a SECOND time for a field the renderer reads only to explain
 * losses. The report is what the renderer needs; the payload is not.
 */
export type RewindSessionAttachment = {
  status: 'restored' | 'unavailable' | 'unsupported'
  reason?: 'external-reference' | 'unreadable'
  mediaType: string | null
  name: string | null
}

export type RewindSessionResult = {
  provider: AgentProviderKind
  newProviderSessionId: string
  newFilePath: string
  promptText: string
  promptMode: 'prompt' | 'bash'
  promptImages: RewindSessionImage[]
  /** Every attachment the rewound prompt had, bytes excluded — see above. */
  promptAttachments: RewindSessionAttachment[]
  promptTimestamp: string | null
}

/**
 * The loss report, with every payload stripped.
 *
 * Exported so the stripping is testable on its own: it is the one thing
 * standing between a 2.8 MB prompt and a 5.6 MB IPC message.
 */
export function toRewindSessionAttachments(
  attachments: readonly RewindAttachment[],
): RewindSessionAttachment[] {
  return attachments.map(attachment => ({
    status: attachment.status,
    ...(attachment.status === 'unavailable' ? { reason: attachment.reason } : {}),
    mediaType: attachment.mediaType,
    name: attachment.name,
  }))
}

export async function listRewindPrompts(
  request: ListRewindPromptsRequest,
): Promise<RewindPrompt[]> {
  const adapter = getHostTranscriptAdapter(request.provider)
  const prompts = await adapter.listPrompts(
    request.cwd,
    request.sourceProviderSessionId,
  )
  // The transcript analyzer returns document order; the picker wants newest
  // first. No cap unless the caller asks for one: the rewind picker lists
  // every prompt (a cap of thirty hid the one the user wanted on any long
  // session), while an external operator can still bound its page. A finite
  // limit is honoured as before.
  if (request.limit === undefined) return prompts.slice().reverse()
  const limit = Number.isFinite(request.limit) ? Math.max(1, Math.floor(request.limit)) : prompts.length
  return prompts.slice(-limit).reverse()
}

export async function rewindSession(
  request: RewindSessionRequest,
): Promise<RewindSessionResult> {
  if (request.anchor.provider !== request.provider) {
    throw new Error(
      `Rewind address is for ${request.anchor.provider}, not ${request.provider}.`,
    )
  }

  const adapter = getHostTranscriptAdapter(request.provider)
  const conversation = await adapter.read(
    request.cwd,
    request.sourceProviderSessionId,
  )
  const rewind = rewindConversation(conversation, request.anchor)
  if (!rewind.conversation.entries.some(entry => entry.kind !== 'opaque')) {
    // Provider-native loaders do not share a portable empty-history shape.
    // Treat "before the first prompt" as a new-session operation rather than
    // writing a file that only one current CLI happens to tolerate.
    throw new Error('No resumable conversation remains before that prompt.')
  }

  // #1038: a duplicate and a rewind are the SAME conversation continuing, so
  // it keeps the model it ran on. Without this the projector stamped the
  // machine's current default on every message, silently moving the copy to
  // whatever model the user last picked somewhere else. A provider SWITCH is
  // different and still takes the destination's default: there is no source
  // model to inherit across providers.
  // Promise.resolve wraps the OPTIONAL call: an adapter without
  // sourceProfile (Claude, Codex) returns undefined, and `.catch` on
  // undefined throws — which would turn a missing capability into a failed
  // duplicate. A failing export is not fatal either; the projector then
  // resolves its own target profile.
  const sourceProfile = await Promise.resolve(adapter.sourceProfile?.(request.cwd, request.sourceProviderSessionId)).catch(() => null)
  const projection = await adapter.projectNativeResume(rewind.conversation, {
    cwd: request.cwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
    ...(sourceProfile ? { targetProfile: sourceProfile } : {}),
  })
  const newProviderSessionId = adapter.sessionId(projection)
  const draft = adapter.draft(rewind.draft)

  // All resolution, truncation, cleanup, and projection happens before this
  // single write. A stale address or incompatible target therefore cannot
  // leave a half-created provider session on disk.
  const newFilePath = await adapter.write(request.cwd, projection)
  return {
    provider: request.provider,
    newProviderSessionId,
    newFilePath,
    promptText: draft.promptText,
    promptMode: draft.promptMode,
    promptImages: draft.promptImages,
    // Listed field by field rather than spread: a spread bypasses excess
    // property checking, which is how `promptAttachments` crossed IPC
    // undeclared in the first place, duplicating multi-megabyte payloads that
    // nothing could read (#1073 review, finding 3).
    promptAttachments: toRewindSessionAttachments(draft.promptAttachments),
    promptTimestamp: rewind.anchor.line >= 0
      ? conversation.entries.find(entry => (
        entry.kind === 'message' &&
        entry.role === 'user' &&
        entry.source.line === rewind.anchor.line
      ))?.timestamp ?? null
      : null,
  }
}
