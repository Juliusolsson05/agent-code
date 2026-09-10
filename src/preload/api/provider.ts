import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type {
  ListRewindPromptsRequest,
  RewindPrompt,
  RewindPromptAddress,
} from '@shared/types/transcriptRewind.js'
import { ipcRenderer } from 'electron'
import { subscribe } from '@preload/api/ipc.js'

// Provider-level session transforms on the bridge.
//
// Mutating methods produce a NEW provider session id whose on-disk transcript
// is a transformation of the source's; prompt listing is read-only. The source
// file is never touched. The renderer hands a returned id to `replaceSession`
// so the focused pane re-homes onto the transformed conversation.
//
// Grouped separately from sessionApi because these are "write a new
// file, return a new id" operations — they don't spawn or kill
// sessions directly. Mirrors the split in main/ipc/provider.ts.

export const providerApi = {
  /**
   * Translate the persisted transcript backing a provider session into the
   * other provider's on-disk format and return the newly created target
   * provider session id. The renderer uses that id with replaceSession(...)
   * so the pane stays in place while the backend swaps from Claude<->Codex.
   */
  switchProvider: (params: {
    sourceKind: AgentProviderKind
    /** Explicit target (#394 phase 5a). Optional for back-compat; new
     *  callers must pass it — the two-provider negation default dies
     *  when a third provider registers. */
    targetKind?: AgentProviderKind
    sourceProviderSessionId: string
    cwd: string
    sourceCwd?: string
    targetCwd?: string
    /** Agent Code's live routing id. Required when native compaction may be
     *  needed before the persisted transcript can fit the target provider. */
    sourceSessionId?: string
    /** What the transaction may spend to make the conversation portable.
     *  Both halves default to false (see DEFAULT_SWITCH_CONTEXT_POLICY):
     *  `allowSourceTurns` opts back into asking the SOURCE to compact itself,
     *  which is exactly what a rate-limited source cannot do; `compactOnArrival`
     *  is a record of intent for the renderer to act on after replaceSession,
     *  not something the switch itself performs. */
    contextPolicy?: {
      allowSourceTurns?: boolean
      compactOnArrival?: boolean
    }
    /** The caller already confirmed that compacting the live source is
     *  acceptable, so the main process skips its per-agent native dialog. Only
     *  reachable with `contextPolicy.allowSourceTurns: true`; a bulk switch
     *  confirms once for the batch instead of once per agent. */
    sourceCompactionConfirmed?: boolean
  }): Promise<{
    kind: 'switched'
    targetKind: AgentProviderKind
    targetProviderSessionId: string
    targetFilePath: string
    compactedBeforeSwitch: boolean
    truncatedBeforeSwitch: boolean
    /** How the conversation was made to fit: `native` lost nothing, `raw`
     *  dropped only a carrier the target could not have read, `shrunk` removed
     *  content the deterministic ladder had to remove. */
    strategy: 'native' | 'raw' | 'shrunk'
    /** One human-readable line describing what `shrunk` cost, else null. The
     *  renderer shows it per pane and counts strategies in a batch summary. */
    shrinkSummary: string | null
  } | {
    /** A provider id can identify a pre-created but still blank session. */
    kind: 'source-empty'
    targetKind: AgentProviderKind
  }> => ipcRenderer.invoke('session:switch-provider', params),

  /**
   * Ask the pane a switch just created to compact its imported history with
   * its OWN quota.
   *
   * Called after `replaceSession` returns, never before: the transcript is
   * already durable and the pane already live, which is exactly why this is a
   * separate call instead of a flag on `switchProvider`. It resolves with
   * `{ ok: false, message }` rather than rejecting for every failure the target
   * can produce — the switch itself already succeeded, and a failed tidy-up
   * must not be reported to the user as a failed switch.
   *
   * Claude targets only. A Codex or OpenCode `targetKind` comes back as an
   * `ok: false` report rather than an error, so the caller needs no provider
   * check of its own.
   */
  compactAfterSwitch: (params: {
    /** Agent Code's routing id for the NEW pane, not the pre-switch one. */
    sessionId: string
    targetKind: AgentProviderKind
    cwd: string
    /** The provider session id `switchProvider` wrote and the pane resumed. */
    providerSessionId: string
  }): Promise<
    | { ok: true; via: 'resume-prompt' | 'compact-command' }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('session:compact-after-switch', params),

  onProviderSwitchProgress: (cb: (event: {
    sourceSessionId: string
    phase: 'compacting' | 'summarizing' | 'shrinking' | 'projecting'
    message: string
  }) => void): (() => void) => subscribe('session:provider-switch-progress', cb),

  /**
   * Duplicate a provider session on disk. Reads the source transcript,
   * clones it with a fresh session id (and fresh timestamp for
   * Codex), writes the clone next to the original, and returns the
   * new id. The renderer then passes that id to `spawnSession` /
   * `newTab` with `resumeSessionId: newProviderSessionId` to bring
   * the duplicate online as an independent conversation.
   *
   * Idempotent wrt the source file — the source is untouched. Live
   * sessions can be duplicated; the clone is a point-in-time
   * snapshot (later appends to the live source do not land in it).
   */
  duplicateSession: (params: {
    provider: AgentProviderKind
    sourceProviderSessionId: string
    cwd: string
    sourceCwd?: string
    targetCwd?: string
  }): Promise<{
    provider: AgentProviderKind
    newProviderSessionId: string
    newFilePath: string
  }> => ipcRenderer.invoke('session:duplicate', params),

  /**
   * Rewind a provider session to "just before" a selected user prompt.
   * Produces a NEW provider session id whose on-disk transcript
   * contains every entry strictly before the anchor (with orphan
   * tool_use/call pairing cleaned up). The original file is not
   * modified.
   *
   * The caller then:
   *   1. Passes `newProviderSessionId` to `replaceSession(...)` so the
   *      focused pane re-homes onto the rewound transcript.
   *   2. Prefills the pane's composer with `promptText` as an unsent
   *      draft — the rewound session opens in "continue from here
   *      with an editable prompt" mode, not "replay this prompt".
   *
   * The address is copied from main-process transcript analysis. It must never
   * be reconstructed from the renderer's filtered feed rows.
   */
  listRewindPrompts: (
    params: ListRewindPromptsRequest,
  ): Promise<RewindPrompt[]> => ipcRenderer.invoke('session:list-rewind-prompts', params),

  /**
   * Fork a Codex session with the last model step after a `cyber_policy`
   * task_complete removed. Produces a NEW provider session id. The original
   * rollout is not modified. The caller re-homes the pane with
   * `replaceSession(...)` and leaves the composer draft as-is.
   */
  stripCodexCyberPolicy: (params: {
    provider: AgentProviderKind
    sourceProviderSessionId: string
    cwd: string
  }): Promise<{
    provider: 'codex'
    newProviderSessionId: string
    newFilePath: string
  }> => ipcRenderer.invoke('session:strip-codex-cyber-policy', params),

  rewindToPrompt: (params: {
    provider: AgentProviderKind
    sourceProviderSessionId: string
    cwd: string
    anchor: RewindPromptAddress
  }): Promise<{
    provider: AgentProviderKind
    newProviderSessionId: string
    newFilePath: string
    /** Unwrapped prompt text — `<bash-input>` / `<command-name>/args>`
     *  envelopes unpacked, IDE-context tags stripped. Mirrors
     *  claude-code-src `textForResubmit`. */
    promptText: string
    /** `'bash'` when the anchored prompt was a bash-input envelope;
     *  otherwise `'prompt'`. Caller can prefix `!` on the draft for
     *  bash mode, same as CC's composer. Codex anchors always report
     *  `'prompt'`. */
    promptMode: 'prompt' | 'bash'
    /** Images pulled from the anchored user entry (Claude only).
     *  Empty for codex responses since codex rollouts don't carry
     *  image blocks. */
    promptImages: Array<{ mediaType: string; data: string }>
    promptTimestamp: string | null
  }> => ipcRenderer.invoke('session:rewind-to-prompt', params),
}
