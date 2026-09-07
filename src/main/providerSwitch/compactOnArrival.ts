// See docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Arrival compaction". Runs AFTER the pane was replaced, on the NEW session,
// with the TARGET's quota.
//
// WHY this is a separate module rather than a tail on switchProvider: the
// switch transaction's whole contract is "nothing is replaced until a durable
// target transcript exists". Arrival compaction happens on the other side of
// that line — the pane is already live — so folding it in would either move
// pane replacement before the transcript write or give the transaction a step
// whose failure must not fail it. Both are worse than a second entry point.
//
// WHY failure is reported and never thrown: this is the quota-independent
// path's whole reason for existing (#821). The source provider is out of quota,
// so the switch deliberately spent NOTHING on it and carried the history over
// raw or shrunk. The pane is now live with that full history. If the target
// then refuses to compact — busy composer, no resume prompt, a timeout — the
// user is no worse off than before; they can compact by hand. Throwing here
// would turn "the extra tidy-up did not happen" into "your switch failed",
// which is a lie about a transaction that already committed.
import { setTimeout as delay } from 'node:timers/promises'

import { conversationAfterLatestPortableCompaction, describeLatestCompaction } from 'agent-transcript-parser'

import type { SessionManager } from '@main/sessionManager.js'
import {
  latestSourceLine,
  waitForNewCompactionOn,
} from '@main/providerSwitch/compactBeforeSwitch.js'
import type { TranscriptWatchTarget } from '@main/providerSwitch/compactBeforeSwitch.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import type { ProviderSwitchProgress } from '@main/providerSwitch/switchProvider.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type CompactOnArrivalRequest = {
  sessionId: string
  targetKind: AgentProviderKind
  cwd: string
  providerSessionId: string
}

export type CompactOnArrivalResult =
  | { ok: true; via: 'resume-prompt' | 'compact-command' }
  | { ok: false; message: string }

// WHY a bounded wait for the resume prompt: Claude shows it only after the
// transcript is restored, and only for sessions over ~100k tokens that have
// been idle for over an hour. A projected transcript copies the SOURCE's
// timestamps, so a parked agent usually qualifies and a just-active one does
// not — which means "no prompt" is a normal outcome, not an error, and the
// `/compact` fallback below is the common path. Ten seconds covers restore on
// the largest local transcripts (53 MB) without stalling a batch of twenty.
const RESUME_PROMPT_WAIT_MS = 10_000
const RESUME_PROMPT_POLL_MS = 250
const UP_ARROW = '\x1b[A'
const RESUME_PROMPT_CONDITION = 'claude.resume-prompt'

export async function compactOnArrival(
  manager: SessionManager,
  request: CompactOnArrivalRequest,
  onProgress?: (progress: ProviderSwitchProgress) => void,
): Promise<CompactOnArrivalResult> {
  // Codex and OpenCode targets skip this step entirely: Codex auto-compacts at
  // its own threshold and the projection is written below it, and OpenCode has
  // no slash-command surface outside its TUI. Reporting instead of throwing
  // keeps the renderer's call site free of a provider check it would otherwise
  // have to keep in sync with this one.
  if (request.targetKind !== 'claude') {
    return { ok: false, message: 'Arrival compaction is only implemented for Claude targets.' }
  }
  if (manager.getSessionKind(request.sessionId) !== 'claude') {
    return { ok: false, message: 'The new pane is not a live Claude session.' }
  }

  const adapter = getHostTranscriptAdapter('claude')
  // Both baselines come out of ONE decode for the same reason
  // compactBeforeSwitch takes them together: they must describe the same
  // instant of the same file, or the hazard check inside the wait would
  // compare a fingerprint from before an append against a line number from
  // after it. Only the two scalars survive this frame (#720 retention rule —
  // this function then suspends on timers for up to five minutes, and V8 keeps
  // every live register of a suspended async function alive).
  const baseline = await adapter.read(request.cwd, request.providerSessionId).then(conversation => ({
    fingerprint: describeLatestCompaction(conversation)?.fingerprint ?? null,
    line: latestSourceLine(conversation),
  }))
  const target: TranscriptWatchTarget = {
    sessionId: request.sessionId,
    kind: 'claude',
    cwd: request.cwd,
    providerSessionId: request.providerSessionId,
  }

  // Progress is addressed to the NEW session id. `ProviderSwitchProgress` calls
  // that field `sourceSessionId` because the transaction that owns the channel
  // watches the source; here the pane being worked on IS the new one, and it is
  // the only pane the user can still see.
  onProgress?.({
    sourceSessionId: request.sessionId,
    phase: 'compacting',
    message: 'Compacting the imported history with Claude…',
  })

  try {
    const answered = await answerResumePrompt(manager, request.sessionId)
    if (!answered) {
      const delivery = await manager.deliverPromptToAgent(request.sessionId, '/compact')
      if (!delivery.ok) {
        return { ok: false, message: `Claude did not accept /compact: ${delivery.message}` }
      }
    }
    // The same wait the source path uses, now pointed at the target session:
    // same "is the new boundary durable yet" question, same two #820 hazards
    // (an api_error answer instead of a compaction, and a usage-limit message
    // persisted AS the summary). Claude's native summary is itself the portable
    // carrier, so the post-compaction document is what the wait selects.
    await waitForNewCompactionOn(
      manager,
      target,
      baseline.fingerprint,
      baseline.line,
      conversationAfterLatestPortableCompaction,
    )
    return { ok: true, via: answered ? 'resume-prompt' : 'compact-command' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Answer a visible `claude.resume-prompt` with "Resume from summary", or report
 * that none appeared within the bounded wait.
 *
 * WHY the caller moves the cursor itself: the headless condition module
 * deliberately exposes only the two view-independent keystrokes (confirm `\r`,
 * cancel `\x1b`) and documents that selection movement belongs to the caller —
 * fabricating a per-option action array would be a lie the renderer already
 * ignores (packages/claude-code-headless/src/conditions/resumePrompt.ts). So
 * this mirrors what ResumePromptModal's `moveSelection` does: repeat the arrow
 * until the cursor sits on the target row, then Enter.
 *
 * Option 1 ("Resume from summary (recommended)") is index 0, and Claude opens
 * the prompt with the cursor below it, so the move is `selectedIndex` Ups.
 */
async function answerResumePrompt(manager: SessionManager, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + RESUME_PROMPT_WAIT_MS
  while (Date.now() < deadline) {
    const snapshot = manager.getConditionsSnapshot(sessionId)
    const state = snapshot?.conditions[RESUME_PROMPT_CONDITION]?.state as
      | { visible?: boolean; selectedIndex?: number }
      | undefined
    if (state?.visible) {
      const moves = Math.max(0, state.selectedIndex ?? 1)
      for (let i = 0; i < moves; i += 1) requireWrite(manager, sessionId, UP_ARROW)
      requireWrite(manager, sessionId, '\r')
      return true
    }
    await delay(RESUME_PROMPT_POLL_MS)
  }
  return false
}

// `SessionManager.write` returns false rather than throwing when the session is
// gone or a prompt delivery already owns the composer — and a half-answered
// resume prompt is the worst state to walk away from, because the next thing
// this module would do is wait five minutes for a compaction nobody asked for.
// Turn the refusal into the reported failure the caller's try/catch already
// knows how to surface.
function requireWrite(manager: SessionManager, sessionId: string, data: string): void {
  if (!manager.write(sessionId, data)) {
    throw new Error('Claude did not accept the resume-prompt keystrokes; the pane kept its full history.')
  }
}
