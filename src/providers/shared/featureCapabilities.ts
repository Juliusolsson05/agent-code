import { isAgentProviderKind } from '@shared/types/providerKind'
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
   * The transcript parser can pull USER PROMPTS out of this provider's entries.
   *
   * Distinct from `transcriptRewind`, which needs a full adapter able to
   * rewrite history — this is only the read side, and it is what View Prompts
   * and the Rewind picker list. `extractLatestUserPrompts` currently keys off
   * Claude's `permissionMode` field (with an explicit Codex exception), so a
   * provider whose entries lack it yields an empty list and the modal opens
   * blank.
   */
  promptHistoryExtraction: boolean
  /**
   * The session manager can respawn this provider with a `resumeSessionId` and
   * have it replay history — what Reload Agent does.
   *
   * NOT the same capability as `verifiedExternalResumeCommand`, and conflating
   * the two got Reload Agent hidden for OpenCode, which supports in-app resume
   * perfectly well (`opencodeSession.ts` passes the id through as `sessionID`
   * and replays). One is about a shell string we hand the user; this one is
   * about our own spawn path. A provider can have either without the other.
   */
  inAppResume: boolean
  /**
   * `resumeCommand` has been VERIFIED against the real CLI. False means the
   * template is a plausible guess, and Copy Resume Command would hand the user
   * a shell command that may not work — worse than not offering it, because
   * they will paste it into a terminal and blame their setup.
   */
  verifiedExternalResumeCommand: boolean
}

/**
 * Nothing. The capability set for a value that is not an agent provider.
 *
 * Exported so a caller can compare against it rather than hand-writing five
 * `false`s and drifting when a sixth capability is added.
 */
export const NO_PROVIDER_FEATURES: ProviderFeatureCapabilities = {
  savedSessionListing: false,
  transcriptRewind: false,
  transcriptDuplicate: false,
  promptHistoryExtraction: false,
  inAppResume: false,
  switchTargets: [],
  verifiedExternalResumeCommand: false,
}

/**
 * The capability matrix, as ONE exhaustive table.
 *
 * WHY a central table rather than a `features` block on each provider's
 * identity descriptor (where this started): the identity files live under
 * `providers/<kind>/renderer/**`, which the node tsconfig project excludes
 * because that subtree is renderer-only. Anything node-side reaching them
 * fails the build. Capabilities have to be readable by command guards, tests
 * and eventually main, so they cannot live behind a renderer-only boundary.
 *
 * The exhaustive `Record<AgentProviderKind, …>` preserves the property that
 * mattered: adding a provider to AGENT_PROVIDER_KINDS fails to compile until
 * it answers every question here. A provider still cannot inherit features by
 * existing — it has to declare them.
 */
const FEATURES_BY_KIND: Record<AgentProviderKind, ProviderFeatureCapabilities> = {
  // Saved-session index, a transcript adapter used by both rewind and
  // duplicate, a verified `claude --resume` form, and a translation edge to
  // Codex.
  claude: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    promptHistoryExtraction: true,
    inAppResume: true,
    switchTargets: ['codex'],
    verifiedExternalResumeCommand: true,
  },
  // Mirrors Claude, with the reverse translation edge.
  codex: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    promptHistoryExtraction: true,
    inAppResume: true,
    switchTargets: ['claude'],
    verifiedExternalResumeCommand: true,
  },
  // Almost everything false, and that is the correction rather than a slight.
  // OpenCode has no saved-session listing in main, no transcript adapter for
  // rewind or duplicate to operate on, no switch edge in either direction, and
  // its resumeCommand template is an unverified guess (see the note in its
  // identity descriptor). Agent-hood previously granted all of it implicitly,
  // so the commands appeared enabled and then did nothing.
  //
  // Flip these individually as each adapter becomes real; never as a group.
  opencode: {
    savedSessionListing: false,
    transcriptRewind: false,
    transcriptDuplicate: false,
    // `extractLatestUserPrompts` filters on Claude's `permissionMode` field
    // unless the kind is codex, so OpenCode entries all fall through and View
    // Prompts opens empty.
    promptHistoryExtraction: false,
    // TRUE, and the one place OpenCode is not behind. `opencodeSession`
    // accepts a resume id and replays the session's messages, so Reload Agent
    // works — it was only hidden because the guard read the flag for the
    // unrelated shell-command feature.
    inAppResume: true,
    switchTargets: [],
    verifiedExternalResumeCommand: false,
  },
}

/**
 * Feature capabilities for a provider kind, or nothing for a terminal or an
 * unknown value.
 *
 * WHY this lives here and NOT on the renderer capability registry, where it
 * started: `registry.renderer.capabilities.ts` imports provider `.tsx` row and
 * view components, which the node tsconfig project deliberately excludes. A
 * node-side file reaching the registry drags that JSX graph into a project
 * that cannot compile it — 72 errors, which is exactly what a test importing
 * it produced. Keeping capabilities as node-safe data avoids the boundary
 * entirely.
 */
export function getProviderFeatures(kind: string | undefined): ProviderFeatureCapabilities {
  if (!kind || !isAgentProviderKind(kind)) return NO_PROVIDER_FEATURES
  return FEATURES_BY_KIND[kind]
}
