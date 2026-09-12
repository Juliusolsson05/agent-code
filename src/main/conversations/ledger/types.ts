import type { AgentProviderKind } from '@shared/types/providerKind.js'

/** What Agent Code durably remembers about a conversation that ran here. The
 *  catalog joins it by `provider:nativeId`; historical transcripts have none. */
export type LedgerRow = {
  provider: AgentProviderKind
  nativeId: string
  localSessionId: string | null
  cwd: string | null
  title: string | null
  agentName: string | null
  orchestration: {
    parentNativeId: string | null
    role: string | null
    runId: string | null
  } | null
  firstSeenAt: number
  lastSeenAt: number
  closedAt: number | null
}
