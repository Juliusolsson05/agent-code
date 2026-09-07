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
// which is a lie about a transaction that already committed. Everything below
// the guard clauses is inside ONE try for that reason: a rejected transcript
// read or a throwing progress callback must come back as `{ ok: false }` like
// every other failure, not as a rejected promise the IPC layer turns into an
// exception on a committed switch.
import { setTimeout as delay } from 'node:timers/promises'

import { conversationAfterLatestPortableCompaction, describeLatestCompaction } from 'agent-transcript-parser'
// Type-only, so nothing from the provider package reaches this module's runtime
// graph. It is the authority on what `claude.resume-prompt` carries, and
// declaring the shape by hand is how a rename in the parser would become a
// silent `undefined` here instead of a compile error.
import type { ResumePromptState } from 'claude-code-headless'

import type { SessionManager } from '@main/sessionManager.js'
import {
  latestSourceLine,
  waitForNewCompactionOn,
} from '@main/providerSwitch/compactBeforeSwitch.js'
import type {
  CompactionWaitPhrasing,
  TranscriptWatchTarget,
} from '@main/providerSwitch/compactBeforeSwitch.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import type { ProviderSwitchProgress } from '@main/providerSwitch/switchProvider.js'
import { conditionStateByKind } from '@shared/types/providerConditions.js'
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

/**
 * Every failure here happens on a pane that is already live on the target with
 * its complete imported history, so none of them is an aborted switch. The
 * clause tells the user the two things that are actually true: nothing was
 * lost, and the tidy-up is one command away.
 */
const ARRIVAL_PHRASING: CompactionWaitPhrasing = {
  exited: 'The new Claude session exited while compacting on arrival; the pane keeps its full history.',
  consequence: 'the imported history is intact and you can run /compact by hand',
}

/**
 * How long to wait for the new pane to finish restoring.
 *
 * ESTIMATE, not a measurement: it has to cover Claude replaying a projected
 * transcript that can be tens of megabytes (the largest local one is 53 MB)
 * while nineteen sibling agents do the same thing, and no recording of that
 * exists yet — Stage 0 captured none and Stage 7's probe is where it gets
 * pinned down. Too short reports a failure on a pane that was merely slow; too
 * long parks a batch. Thirty seconds is the compromise, and the failure it
 * produces is non-fatal by construction.
 */
const ARRIVAL_READY_WAIT_MS = 30_000
const ARRIVAL_POLL_MS = 250
const UP_ARROW = '\x1b[A'
const RESUME_PROMPT_CONDITION = 'claude.resume-prompt'

/**
 * What the new pane settled into, and therefore how to ask it to compact.
 *
 * WHY readiness and the resume prompt are ONE wait with two exits, rather than
 * "wait for ready, then look for a prompt" (which is what the spec's step list
 * reads like):
 *
 * A visible condition BLOCKS prompt input. `ClaudeSession.derivePromptGateState`
 * (src/providers/claude/runtime/claudeSession.ts:769) returns `blocked` for any
 * live condition that `conditionBlocksPromptInput` accepts (:1251 — everything
 * except a non-running compaction), and `input.ready` is `gate.kind === 'ready'`.
 * So while the resume prompt is on screen, readiness is FALSE and stays false
 * until the prompt is answered. Waiting for readiness first would therefore
 * deadlock on exactly the case the prompt exists for: it would time out without
 * ever answering, on the biggest, oldest sessions — the ones arrival compaction
 * is most needed for.
 *
 * Once `ready` is true no prompt is showing, and a fresh pane's readiness starts
 * at `{ ready: false, reason: 'starting' }` (SessionManager sets it at spawn),
 * so a stale `true` from the pre-switch session cannot leak in either.
 */
type ArrivalReadiness =
  | { kind: 'resume-prompt'; selectedIndex: number }
  | { kind: 'input-ready' }
  | { kind: 'exited' }
  | { kind: 'timeout' }

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

  try {
    const adapter = getHostTranscriptAdapter('claude')
    // Both baselines come out of ONE decode for the same reason
    // compactBeforeSwitch takes them together: they must describe the same
    // instant of the same file, or the hazard check inside the wait would
    // compare a fingerprint from before an append against a line number from
    // after it. Only the two scalars survive this frame (#720 retention rule —
    // this function then suspends on timers for up to five minutes, and V8
    // keeps every live register of a suspended async function alive).
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

    // Progress is addressed to the NEW session id. `ProviderSwitchProgress`
    // calls that field `sourceSessionId` because the transaction that owns the
    // channel watches the source; here the pane being worked on IS the new one,
    // and it is the only pane the user can still see.
    onProgress?.({
      sourceSessionId: request.sessionId,
      phase: 'compacting',
      message: 'Compacting the imported history with Claude…',
    })

    const readiness = await waitForArrivalReadiness(manager, request.sessionId)
    if (readiness.kind === 'exited') {
      return { ok: false, message: 'The new Claude session exited before it finished restoring; the pane keeps its full history.' }
    }
    if (readiness.kind === 'timeout') {
      return { ok: false, message: `Claude did not finish restoring the imported history within ${Math.round(ARRIVAL_READY_WAIT_MS / 1000)}s; ${ARRIVAL_PHRASING.consequence}.` }
    }

    if (readiness.kind === 'resume-prompt') {
      answerResumePrompt(manager, request.sessionId, readiness.selectedIndex)
    } else {
      const delivery = await manager.deliverPromptToAgent(request.sessionId, '/compact')
      if (!delivery.ok) {
        return { ok: false, message: `Claude did not accept /compact: ${delivery.message}` }
      }
    }

    // The same wait the source path uses, now pointed at the target session:
    // same "is the new boundary durable yet" question, same two #820 hazards
    // (an api_error answer instead of a compaction, and a usage-limit message
    // persisted AS the summary). Claude's native summary is itself the portable
    // carrier, so the post-compaction document is what the wait selects. The
    // phrasing is this side's, because none of those failures aborts a switch
    // that already committed.
    await waitForNewCompactionOn(
      manager,
      target,
      baseline.fingerprint,
      baseline.line,
      ARRIVAL_PHRASING,
      conversationAfterLatestPortableCompaction,
    )
    return { ok: true, via: readiness.kind === 'resume-prompt' ? 'resume-prompt' : 'compact-command' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Poll the new pane until it is ready for input, is asking the resume question,
 * or the deadline passes. See `ArrivalReadiness` for why those are one wait.
 *
 * Liveness is re-checked on every tick, the way `pollSourceUntil` does it: a
 * pane the user closed (or a backend that died replaying the import) would
 * otherwise be polled for the full deadline and then reported as slow rather
 * than gone.
 */
async function waitForArrivalReadiness(
  manager: SessionManager,
  sessionId: string,
): Promise<ArrivalReadiness> {
  const deadline = Date.now() + ARRIVAL_READY_WAIT_MS
  while (Date.now() < deadline) {
    if (manager.getSessionKind(sessionId) !== 'claude') return { kind: 'exited' }
    const prompt = conditionStateByKind<ResumePromptState>(
      manager.getConditionsSnapshot(sessionId),
      RESUME_PROMPT_CONDITION,
    )
    // The prompt wins over readiness when both somehow read true: answering it
    // is strictly better than typing `/compact`, because Claude's own
    // "Resume from summary" compaction is what the pane is already offering.
    if (prompt?.visible) return { kind: 'resume-prompt', selectedIndex: prompt.selectedIndex ?? 1 }
    if (manager.getBackendSnapshot(sessionId)?.input.ready) return { kind: 'input-ready' }
    await delay(ARRIVAL_POLL_MS)
  }
  return { kind: 'timeout' }
}

/**
 * Answer a visible `claude.resume-prompt` with "Resume from summary".
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
function answerResumePrompt(manager: SessionManager, sessionId: string, selectedIndex: number): void {
  const moves = Math.max(0, selectedIndex)
  for (let i = 0; i < moves; i += 1) requireWrite(manager, sessionId, UP_ARROW)
  requireWrite(manager, sessionId, '\r')
}

// `SessionManager.write` returns false rather than throwing when the session is
// gone or a prompt delivery already owns the composer — and a half-answered
// resume prompt is the worst state to walk away from, because the next thing
// this module would do is wait five minutes for a compaction nobody asked for.
// Turn the refusal into the reported failure the caller's try/catch already
// knows how to surface.
//
// The keystrokes are journalled under the default origin `'renderer'`: this is
// a host-initiated condition answer, and `write`'s origin enum deliberately
// excludes the provider-owned `'delivery'`/`'condition'` buckets, so the honest
// label for "not a provider delivery" is the default one (sessionManager.ts
// `write`, and the WHY on InputWriteOrigin).
function requireWrite(manager: SessionManager, sessionId: string, data: string): void {
  if (!manager.write(sessionId, data)) {
    throw new Error('Claude did not accept the resume-prompt keystrokes; the pane kept its full history.')
  }
}
