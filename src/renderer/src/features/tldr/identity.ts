import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { hasReportingDomain } from '@shared/types/tldr'
import type { SessionMeta } from '@renderer/workspace/types'

export function tldrIdentityForSession(sessionId: string, source: SessionMeta): string | undefined {
  // Main-created agents can acquire TLDR or Goal before renderer metadata is
  // attached; their authenticated MCP scope defaults to the local routing ID.
  // Agents that never enabled either need no extra persisted identity at all.
  return source.tldrIdentity ?? (hasReportingDomain(source.builtInMcpDomains) ? sessionId : undefined)
}

export function tldrIdentityForReplacement(
  sessionId: string,
  source: SessionMeta,
  target: { kind: string; resumeSessionId?: string; preserveTldr?: boolean },
): string | undefined {
  if (target.kind === 'terminal') return undefined
  // Provider translation explicitly carries the logical conversation. An
  // ordinary replacement only does so when resuming the exact same native
  // transcript. Rewind/clone/unrelated resume must not carry future claims.
  const sameConversation = target.preserveTldr || (
    target.kind === (source.kind ?? DEFAULT_PROVIDER)
    && Boolean(source.providerSessionId)
    && target.resumeSessionId === source.providerSessionId
  )
  return sameConversation ? tldrIdentityForSession(sessionId, source) : undefined
}
