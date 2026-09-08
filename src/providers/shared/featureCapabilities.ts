import { isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'

/**
 * What a provider can actually DO, declared explicitly per provider.
 *
 * WHY this exists: the audit found `isAgentProviderKind()` being used as a
 * feature capability. That predicate only distinguishes agents from terminals —
 * it says nothing about whether a provider has a transcript adapter, a
 * saved-session index, or a verified CLI resume form. Because every agent
 * provider passed it, OpenCode was historically offered Resume, Rewind,
 * Duplicate, Switch Provider and Copy Resume before those paths were actually
 * implemented or verified. The user saw an ordinary enabled command and got
 * nothing. OpenCode now declares the capabilities backed by its CLI adapter;
 * this registry still prevents that failure from recurring for a new provider.
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
  /**
   * On this provider's RAW TERMINAL surface, the bytes to send so the TUI
   * scrolls its own transcript to the latest message — or null when the
   * xterm viewport is the thing that scrolls and `scrollToBottom()` is
   * correct.
   *
   * WHY a capability rather than a provider check at the call site: "Jump to
   * Latest" is one command with two completely different mechanisms, and which
   * one applies is a fact about the provider's TUI, not about the pane.
   *
   * Claude Code and Codex render their main view INLINE on the normal screen
   * buffer and push history into real xterm scrollback (Codex's
   * `insert_history_lines`; Claude's AlternateScreen component is documented
   * as being for transient ctrl-o style overlays only). Scrolling the xterm
   * viewport is exactly right for them.
   *
   * OpenCode does not. It runs OpenTUI, whose `screenMode` defaults to
   * `alternate-screen`, and it renders the transcript into an internal
   * `<scrollbox>` with its own paging keybinds. Nothing is ever evicted
   * upward, so `viewportY === baseY` always holds and `term.scrollToBottom()` is a
   * guaranteed no-op — which is why Jump to Latest silently did nothing on
   * OpenCode Terminal panes while working everywhere else. The only mechanism
   * that can move that transcript is the TUI's own key.
   *
   * The plan doc for the follow work already recorded the constraint —
   * "Alternate-screen TUIs often own their history internally. These commands
   * control the xterm viewport, not provider-specific keybindings or internal
   * transcript navigation" — but nothing acted on it, so the command shipped
   * claiming a behaviour it could not deliver.
   */
  terminalJumpToLatestKey: string | null
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
  terminalJumpToLatestKey: null,
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
  // duplicate, a verified `claude --resume` form, and translation edges to
  // both other native-resume adapters.
  claude: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    promptHistoryExtraction: true,
    inAppResume: true,
    switchTargets: ['codex', 'opencode'],
    verifiedExternalResumeCommand: true,
    // Inline on the normal buffer, so real xterm scrollback exists and the
    // viewport is what needs moving.
    terminalJumpToLatestKey: null,
  },
  // Mirrors Claude, with explicit edges to both other adapters.
  codex: {
    savedSessionListing: true,
    transcriptRewind: true,
    transcriptDuplicate: true,
    promptHistoryExtraction: true,
    inAppResume: true,
    switchTargets: ['claude', 'opencode'],
    verifiedExternalResumeCommand: true,
    // Same as Claude: `insert_history_lines` writes to real scrollback, and
    // `enter_alt_screen` is reached only from backtrack/resume/migration
    // overlays, never the chat view.
    terminalJumpToLatestKey: null,
  },
  // OpenCode still lacks a cwd-indexed saved-session picker, but its supported
  // CLI export/import boundary now backs prompt extraction, rewind, duplicate,
  // and pairwise switching. Keep listing separate: being able to address a
  // known `ses_` id does not imply main can enumerate sessions for Resume UI.
  opencode: {
    savedSessionListing: false,
    transcriptRewind: true,
    transcriptDuplicate: true,
    promptHistoryExtraction: true,
    // TRUE, and the one place OpenCode is not behind. `opencodeSession`
    // accepts a resume id and replays the session's messages, so Reload Agent
    // works — it was only hidden because the guard read the flag for the
    // unrelated shell-command feature.
    inAppResume: true,
    switchTargets: ['claude', 'codex'],
    verifiedExternalResumeCommand: true,
    // ESC + 0x07 is Ctrl+Alt+G in the legacy encoding every terminal speaks:
    // Alt is the ESC prefix and Ctrl+G is BEL. OpenCode binds that chord to
    // `messages_last` ("Navigate to last message"), which is precisely this
    // command's meaning inside its own scrollbox.
    //
    // WHY Ctrl+Alt+G and not the bare `End` OpenCode also accepts: `End` is
    // ALSO bound to `input_buffer_end`, so it would most likely move the
    // prompt caret instead of the transcript. Ctrl+Alt+G is unambiguous, and
    // it is a member of OpenCode's whole Ctrl+Alt message-scroll family.
    //
    // WHY legacy bytes even though OpenCode requests the kitty keyboard
    // protocol: xterm 6.0.0 has no kitty support, so it never answers the
    // query and the TUI stays on legacy parsing. If that ever changes this
    // string is the one place to revisit.
    //
    // KNOWN RESIDUAL RISK, stated because it is real and was raised in
    // review: OpenCode keybinds are user-configurable through tui.json, so a
    // user who has rebound this chord gets whatever they bound it to. Under
    // STOCK config that cannot reach anything destructive — the only
    // destructive action nearby is `messages_undo`, which aborts the session
    // and reverts history, and it is bound to `<leader>u`, i.e. Ctrl+X then
    // `u`. No byte sequence sent from here can produce that, because it
    // requires 0x18 first. The exposure is narrow and deliberate: a user who
    // moves a destructive action onto Ctrl+Alt+G.
    //
    // Reading their effective binding to be certain is NOT cheap and would be
    // unreliable — it means reimplementing OpenCode's loader: JSONC, global
    // plus per-project plus every .opencode directory up to home, variable
    // substitution, a legacy-config migration, a win32 special case, and
    // plugin-registered binds. That reimplementation would drift.
    //
    // The rebinding-immune path exists and is the right long-term answer:
    // OpenCode's server exposes POST /tui/execute-command, whose alias table
    // maps `messages_last` to the stable command `session.last` and dispatches
    // it below the keybind layer. It needs a known server URL, which means
    // spawning `opencode serve` and using `opencode attach` instead of running
    // the TUI directly — a topology change, not a one-line swap. Take that
    // route when the OpenCode runtime moves to a served transport.
    terminalJumpToLatestKey: '\u001b\u0007',
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
