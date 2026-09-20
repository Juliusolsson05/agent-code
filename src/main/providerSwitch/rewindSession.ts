import { randomUUID } from 'node:crypto'

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

export type RewindSessionResult = {
  provider: AgentProviderKind
  newProviderSessionId: string
  newFilePath: string
  promptText: string
  promptMode: 'prompt' | 'bash'
  promptImages: RewindSessionImage[]
  promptTimestamp: string | null
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

  const projection = await adapter.projectNativeResume(rewind.conversation, {
    cwd: request.cwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
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
    ...draft,
    promptTimestamp: rewind.anchor.line >= 0
      ? conversation.entries.find(entry => (
        entry.kind === 'message' &&
        entry.role === 'user' &&
        entry.source.line === rewind.anchor.line
      ))?.timestamp ?? null
      : null,
  }
}
