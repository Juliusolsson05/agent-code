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
  }): Promise<{
    kind: 'switched'
    targetKind: AgentProviderKind
    targetProviderSessionId: string
    targetFilePath: string
    compactedBeforeSwitch: boolean
    truncatedBeforeSwitch: boolean
  } | {
    /** A provider id can identify a pre-created but still blank session. */
    kind: 'source-empty'
    targetKind: AgentProviderKind
  }> => ipcRenderer.invoke('session:switch-provider', params),

  onProviderSwitchProgress: (cb: (event: {
    sourceSessionId: string
    phase: 'compacting' | 'summarizing' | 'projecting'
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
