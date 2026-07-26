import type { AgentProviderKind } from '@shared/types/providerKind'

/**
 * What a provider can actually DO, declared explicitly per provider.
 *
 * WHY this exists: the audit found `isAgentProviderKind()` being used as a
 * feature capability. That predicate only distinguishes agents from terminals —
 * it says nothing about whether a provider has a transcript adapter, a
 * saved-session index, or a verified CLI resume form. Because every agent
 * provider passed it, OpenCode was offered Resume, Rewind, Duplicate, Switch
 * Provider and Copy Resume, all of which are empty, rejected, unsupported or
 * unverified for it. The user sees an ordinary enabled command and gets nothing.
 *
 * The rule this replaces it with: a provider gets a feature when it DECLARES
 * the capability, not when it happens to be an agent. Adding a provider now
 * means answering these questions rather than inheriting broad agent powers by
 * joining `AGENT_PROVIDER_KINDS`.
 */
export type ProviderFeatureCapabilities = {
  /**
   * Main can enumerate this provider's saved sessions for a cwd, so the Resume
   * picker has something to list. Without it Resume opens an empty modal.
   */
  savedSessionListing: boolean
  /**
   * The transcript adapter can rewind this provider's transcript to an earlier
   * prompt. Rewind rewrites session history; offering it without an adapter
   * means the command either no-ops or corrupts.
   */
  transcriptRewind: boolean
  /**
   * The transcript adapter can project this provider's transcript into a new
   * session, which is what Duplicate does.
   */
  transcriptDuplicate: boolean
  /**
   * Providers this one can switch TO. An explicit edge list, not a boolean:
   * "can switch" is meaningless without naming the destination, and the
   * translation is directional — a Claude→Codex adapter is not automatically a
   * Codex→OpenCode one.
   */
  switchTargets: readonly AgentProviderKind[]
  /**
   * `resumeCommand` has been VERIFIED against the real CLI. False means the
   * template is a plausible guess, and Copy Resume Command would hand the user
   * a shell command that may not work — worse than not offering it, because
   * they will paste it into a terminal and blame their setup.
   */
  verifiedExternalResumeCommand: boolean
}
