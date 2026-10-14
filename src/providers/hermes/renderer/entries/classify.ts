import type { ProviderDurableEntryKind } from '@shared/types/providerConfig'
import type { Entry } from '@shared/types/transcript'

import { HERMES_NOTICE_ENTRY_TYPE } from '@providers/hermes/renderer/transcript/mapper'

/**
 * A local Hermes notice (slash-command output, "signed out", "conversation
 * replaced") is a provider notice: a durable line in the conversation that is
 * neither the user nor the agent speaking. Gated on Hermes' own entry type so
 * no other provider can acquire it by shape.
 */
export function classifyHermesDurableEntry(entry: Entry): ProviderDurableEntryKind | null {
  return entry.type === HERMES_NOTICE_ENTRY_TYPE ? 'provider-notice' : null
}
