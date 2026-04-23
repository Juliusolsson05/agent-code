// Rewind a live session on disk to "just before" a selected user prompt.
//
// Reads the source provider transcript, calls the parser-layer
// `rewindClaudeTranscript` / `rewindCodexRollout` to produce a
// truncated copy with a fresh provider session id, writes the
// truncated copy next to the original, and returns the new id + the
// anchored prompt text. The renderer passes the new id to
// `replaceSession(...)` to swap the focused pane onto the rewound
// conversation, then prefills the composer with `promptText` as a
// draft (unsent).
//
// Layering mirrors `duplicateSession` / `switchProvider`: this file
// owns fs IO and orchestration; the per-format slicing logic lives in
// the `agent-transcript-parser` package so the parser stays
// browser-buildable and has no Node dependencies.

import {
  rewindClaudeTranscript,
  rewindCodexRollout,
  type RewindClaudeAnchor,
  type RewindCodexAnchor,
} from 'agent-transcript-parser'
import type {
  ClaudeEntry,
  CodexRolloutLine,
} from 'agent-transcript-parser'

import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  readJsonlFile,
  writeClaudeSessionFile,
  writeCodexRolloutFile,
} from './shared.js'

export type RewindSessionAnchor =
  | ({ kind: 'claude' } & RewindClaudeAnchor)
  | ({ kind: 'codex' } & RewindCodexAnchor)

export type RewindSessionRequest = {
  provider: 'claude' | 'codex'
  sourceProviderSessionId: string
  /** Required for Claude — session files are scoped to a cwd.
   *  Ignored for Codex since rollouts are discovered globally. */
  cwd: string
  anchor: RewindSessionAnchor
}

/** Image block recovered from an anchored Claude user entry. Codex
 *  doesn't support pasted images in rollouts so this is always empty
 *  for codex responses. */
export type RewindSessionImage = {
  mediaType: string
  data: string
}

export type RewindSessionResult = {
  provider: 'claude' | 'codex'
  newProviderSessionId: string
  /** Absolute path to the truncated transcript on disk. */
  newFilePath: string
  /** Anchored prompt text, extracted from the source transcript.
   *  Text is unwrapped to match Claude Code's `textForResubmit`
   *  semantics — `<bash-input>` and `<command-name>/<command-args>`
   *  envelopes are unwrapped, IDE-context tags are stripped.
   *  The caller prefills this into the pane's composer as a draft
   *  (`draftInput`); it is NOT written into the truncated file. */
  promptText: string
  /** `'bash'` when the anchored prompt was a bash-input envelope;
   *  otherwise `'prompt'`. Matches Claude Code's composer mode
   *  enum. */
  promptMode: 'prompt' | 'bash'
  /** Images pulled from the anchored user entry in document order.
   *  The caller can restore these into the composer's `draftImages`
   *  so rewinding preserves any pasted attachments. */
  promptImages: RewindSessionImage[]
}

export async function rewindSession(
  request: RewindSessionRequest,
): Promise<RewindSessionResult> {
  if (request.provider === 'claude') {
    return rewindClaude(request)
  }
  return rewindCodex(request)
}

async function rewindClaude(
  request: RewindSessionRequest,
): Promise<RewindSessionResult> {
  if (request.anchor.kind !== 'claude') {
    throw new Error(
      `Claude rewind requires a claude-kind anchor, got ${request.anchor.kind}.`,
    )
  }

  const sourceFilePath = await getClaudeSessionFilePath(
    request.cwd,
    request.sourceProviderSessionId,
  )
  // Snapshot the source at read time. If the session is live and
  // being appended to, later writes don't land in the rewound copy —
  // that's the whole point of the feature; rewinding locks the
  // conversation to the chosen prompt.
  const sourceEntries = await readJsonlFile<ClaudeEntry>(sourceFilePath)
  if (sourceEntries.length === 0) {
    throw new Error(
      `Claude session ${request.sourceProviderSessionId} has no entries on disk.`,
    )
  }

  const { entries, newSessionId, promptText, promptMode, promptImages } =
    rewindClaudeTranscript(sourceEntries, { uuid: request.anchor.uuid })

  if (entries.length === 0) {
    // Handing Claude a transcript with zero entries makes `--resume`
    // choke on load. Fallback behavior: we currently reject at the
    // main boundary and surface the message as a toast. The renderer
    // treats an anchor at position 0 as a legitimate "start over"
    // operation, but the shape required for that is a small
    // bootstrap-only transcript, not an empty file. If we ever want
    // to support that, we add synthetic bootstrap entries here — for
    // now the renderer's picker filter already hides the very-first
    // meta entries, so real anchors never produce an empty retained
    // slice.
    throw new Error(
      'Rewound Claude transcript is empty — no entries remained before the anchor.',
    )
  }

  const newFilePath = await writeClaudeSessionFile(request.cwd, entries)

  return {
    provider: 'claude',
    newProviderSessionId: newSessionId,
    newFilePath,
    promptText,
    promptMode,
    promptImages,
  }
}

async function rewindCodex(
  request: RewindSessionRequest,
): Promise<RewindSessionResult> {
  if (request.anchor.kind !== 'codex') {
    throw new Error(
      `Codex rewind requires a codex-kind anchor, got ${request.anchor.kind}.`,
    )
  }

  const sourceFilePath = await findCodexRolloutPathBySessionId(
    request.sourceProviderSessionId,
  )
  if (!sourceFilePath) {
    throw new Error(
      `Codex rollout for session ${request.sourceProviderSessionId} was not found.`,
    )
  }

  const sourceLines = await readJsonlFile<CodexRolloutLine>(sourceFilePath)
  if (sourceLines.length === 0) {
    throw new Error(
      `Codex rollout ${sourceFilePath} is empty.`,
    )
  }

  const { lines, newSessionId, promptText } = rewindCodexRollout(
    sourceLines,
    { userMessageIndex: request.anchor.userMessageIndex },
  )

  if (lines.length === 0) {
    throw new Error(
      'Rewound Codex rollout is empty — no lines remained before the anchor.',
    )
  }

  const newFilePath = await writeCodexRolloutFile(lines)

  return {
    provider: 'codex',
    newProviderSessionId: newSessionId,
    newFilePath,
    promptText,
    // Codex rollouts don't carry pasted images; the composer image
    // attachments that flow through `input_image` response_items are
    // not the same as Claude's `image` block. We return 'prompt'
    // mode + no images for codex anchors.
    promptMode: 'prompt',
    promptImages: [],
  }
}
