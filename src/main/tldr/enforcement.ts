import type { TldrStore } from './TldrStore.js'
import type { TldrEnforcementStatus } from '@shared/types/tldr.js'

export type TldrHookEvent = 'user-prompt-submit' | 'post-tool-use' | 'stop'
export const TLDR_HOOK_EVENTS: readonly TldrHookEvent[] = ['user-prompt-submit', 'post-tool-use', 'stop']

// The same JSON satisfies both CLIs: Codex's hook engine deliberately mirrors
// Claude Code's hook output contract (see codex-rs hooks/schema/generated).
export type TldrHookOutput =
  | Record<string, never>
  | { decision: 'block'; reason: string }
  | { hookSpecificOutput: { hookEventName: 'UserPromptSubmit'; additionalContext: string } }

export const TLDR_GOAL_CONTEXT = 'Agent Code TLDR: this agent has no TLDR yet. Once you understand the goal of this request, call tldr_update with that goal before starting the work.'
export const TLDR_NEVER_WRITTEN_REASON = 'Agent Code TLDR: this agent has no TLDR yet. Call tldr_update now with the current goal and status in one or two sentences, then finish.'
// With Goal on, the goal has its own record. Asking for it in the TLDR too would
// contradict the TLDR skill ("keep the TLDR to status when goal_set is
// available") and put the goal where the next status update overwrites it.
export const TLDR_STATUS_NEVER_WRITTEN_REASON = 'Agent Code TLDR: this agent has no TLDR yet. Call tldr_update now with the current status in one or two sentences, then finish.'
export const GOAL_SET_CONTEXT = 'Agent Code Goal: this agent has no goal yet. Once you understand what this request is trying to achieve, call goal_set with that goal in one plain sentence before starting the work.'
export const GOAL_NEVER_SET_REASON = 'Agent Code Goal: this agent has no goal yet. Call goal_set now with what this work is trying to achieve, in one plain sentence.'

/** Which reporting capabilities one registration has. The hooks are shared, so
 * the host tells the policy what each session actually enabled. */
export type ReportingFeatures = { tldr: boolean; goal: boolean }

export const TLDR_STALE_REASON = 'Agent Code TLDR: you used tools this turn without updating your TLDR. If this turn changed the task status — an outcome, the next step, or a decision the user must make — call tldr_update now. If nothing changed, finish without updating.'

type TurnState = {
  /** Codex's turn id, when the provider sends one. Claude does not. */
  turnId: string | null
  /** When this turn began: its prompt, or its first tool call when the prompt
   * hook was missed (a reload mid-turn, or an app restart). */
  startedAt: number
  toolUsed: boolean
  blocked: boolean
}

function nonEmptyString(input: unknown, key: string): string | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Decides whether an agent may end its turn without reporting.
 *
 * WHY enforcement lives at turn end instead of in the prompt: instructions are
 * advisory, and agents most reliably forget exactly the two updates that
 * matter — the goal at the start and the outcome at the end. A Stop hook is the
 * one moment both CLIs hand control back before the turn closes, so it is where
 * a missed update can still be recovered rather than merely noticed later.
 *
 * WHY it asks rather than forces a write: a turn that only answered a question
 * should not have to restate an unchanged status. The block reason leaves that
 * judgement to the agent, and a turn blocks at most once, so a disagreement
 * costs one short model step instead of a loop.
 *
 * State is in memory and keyed by registration token. A token belongs to one
 * provider process, so a reload or provider switch starts clean automatically,
 * and nothing about an in-flight turn is worth persisting across an app restart.
 */
export class TldrEnforcement {
  private readonly turns = new Map<string, TurnState>()
  /** Keyed by identity, but remembers which process made contact: see forget(). */
  private readonly contact = new Map<string, { at: string; token: string }>()

  constructor(
    private readonly store: Pick<TldrStore, 'lastWrittenAt'>,
    private readonly now: () => number = Date.now,
    private readonly goalStore?: Pick<TldrStore, 'lastWrittenAt'>,
  ) {}

  async handle(
    token: string,
    identity: string,
    event: TldrHookEvent,
    input: unknown,
    features: ReportingFeatures = { tldr: true, goal: false },
  ): Promise<TldrHookOutput> {
    const at = this.now()
    this.contact.set(identity, { at: new Date(at).toISOString(), token })

    // WHY subagent hooks change nothing: both CLIs run a subagent inside the
    // parent process with the parent's hook config, so its hooks arrive with
    // the parent's bearer, marked only by `agent_id` (Claude's background Task,
    // Codex's spawn_agent). Letting them in would let a child reset the parent's
    // turn, receive the goal nudge and write its own sub-task into the parent's
    // TLDR, or have a background child's tool calls block a later pure-chat turn.
    // Ignoring them loses nothing: spawning the child was itself a tool call by
    // the parent, and that already marked the parent's turn as having done work.
    // Contact is still recorded above — a child's hook proves the hooks load.
    if (nonEmptyString(input, 'agent_id')) return {}
    const turnId = nonEmptyString(input, 'turn_id') ?? null

    if (event === 'user-prompt-submit') {
      // Codex runs this hook again for input steered into a RUNNING turn, with
      // that turn's id. It is the same turn: resetting would erase tool work the
      // agent has not reported, so a "stop and summarize" steer would let an
      // unreported turn end unchallenged.
      if (turnId && this.turns.get(token)?.turnId === turnId) return {}
      this.turns.set(token, { turnId, startedAt: at, toolUsed: false, blocked: false })
      // Asking at the prompt rather than only at Stop is what gets the goal
      // written BEFORE the work: an agent blocked at the end reports what it
      // did, which is not what a user scanning many panes needed during it.
      //
      // With Goal on, the goal has its own home (#936). Asking for it in the
      // TLDR as well would get it overwritten by the next status update.
      // A missing TLDR is still caught at Stop, with a status-only request.
      if (features.goal && this.goalStore) {
        return await this.goalStore.lastWrittenAt(identity) ? {} : {
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: GOAL_SET_CONTEXT },
        }
      }
      if (!features.tldr) return {}
      return await this.store.lastWrittenAt(identity) ? {} : {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: TLDR_GOAL_CONTEXT },
      }
    }

    if (event === 'post-tool-use') {
      const turn = this.turns.get(token)
      if (turn) turn.toolUsed = true
      else this.turns.set(token, { turnId, startedAt: at, toolUsed: true, blocked: false })
      return {}
    }

    // Both CLIs set stop_hook_active once a Stop hook has already made the
    // agent continue. Honouring it is what makes a block strictly one step.
    const stopHookActive = Boolean(input && typeof input === 'object'
      && (input as { stop_hook_active?: unknown }).stop_hook_active === true)
    const turn = this.turns.get(token)
    if (stopHookActive || turn?.blocked) {
      this.turns.delete(token)
      return {}
    }
    // Every missing report is gathered into ONE block. Two capabilities must
    // not mean two blocks: the one-block-per-turn guarantee is what keeps a
    // disagreement with the agent from becoming a loop.
    const reasons: string[] = []
    if (features.goal && this.goalStore && !(await this.goalStore.lastWrittenAt(identity))) {
      reasons.push(GOAL_NEVER_SET_REASON)
    }
    if (features.tldr) {
      const lastWrittenAt = await this.store.lastWrittenAt(identity)
      if (!lastWrittenAt) reasons.push(features.goal && this.goalStore ? TLDR_STATUS_NEVER_WRITTEN_REASON : TLDR_NEVER_WRITTEN_REASON)
      // A pure-chat turn never reaches this: without a tool call there is no
      // evidence the task moved, and a clarifying question must stay free.
      // The goal has no staleness rule — it changes with direction, not work.
      else if (turn?.toolUsed && Date.parse(lastWrittenAt) < turn.startedAt) reasons.push(TLDR_STALE_REASON)
    }
    if (reasons.length > 0) return this.block(token, turn, at, reasons.join('\n\n'))
    this.turns.delete(token)
    return {}
  }

  private block(token: string, turn: TurnState | undefined, at: number, reason: string): TldrHookOutput {
    this.turns.set(token, {
      turnId: turn?.turnId ?? null, startedAt: turn?.startedAt ?? at, toolUsed: turn?.toolUsed ?? false, blocked: true,
    })
    return { decision: 'block', reason }
  }

  /** A revoked registration's process is gone. Its unfinished turn must not
   * leak into the process that replaces it, and neither may its hook contact:
   * a reload keeps the TLDR identity, so contact left behind by the old process
   * would vouch for a replacement whose hooks never ran — exactly the silent
   * failure the peek's inactive note exists to reveal. */
  forget(token: string): void {
    this.turns.delete(token)
    for (const [identity, contact] of this.contact) {
      if (contact.token === token) this.contact.delete(identity)
    }
  }

  status(identities: readonly string[]): Record<string, TldrEnforcementStatus> {
    return Object.fromEntries(identities.map(identity => [identity, { hookContactAt: this.contact.get(identity)?.at ?? null }]))
  }
}
