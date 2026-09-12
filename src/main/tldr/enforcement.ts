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
export const TLDR_STALE_REASON = 'Agent Code TLDR: you used tools this turn without updating your TLDR. If this turn changed the task status — an outcome, the next step, or a decision the user must make — call tldr_update now. If nothing changed, finish without updating.'

type TurnState = {
  /** When this turn began: its prompt, or its first tool call when the prompt
   * hook was missed (a reload mid-turn, or an app restart). */
  startedAt: number
  toolUsed: boolean
  blocked: boolean
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
  private readonly contact = new Map<string, string>()

  constructor(
    private readonly store: Pick<TldrStore, 'lastWrittenAt'>,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(token: string, identity: string, event: TldrHookEvent, input: unknown): Promise<TldrHookOutput> {
    const at = this.now()
    this.contact.set(identity, new Date(at).toISOString())

    if (event === 'user-prompt-submit') {
      this.turns.set(token, { startedAt: at, toolUsed: false, blocked: false })
      // Asking at the prompt rather than only at Stop is what gets the goal
      // written BEFORE the work: an agent blocked at the end reports what it
      // did, which is not what a user scanning many panes needed during it.
      return await this.store.lastWrittenAt(identity) ? {} : {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: TLDR_GOAL_CONTEXT },
      }
    }

    if (event === 'post-tool-use') {
      const turn = this.turns.get(token)
      if (turn) turn.toolUsed = true
      else this.turns.set(token, { startedAt: at, toolUsed: true, blocked: false })
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
    const lastWrittenAt = await this.store.lastWrittenAt(identity)
    if (!lastWrittenAt) return this.block(token, turn, at, TLDR_NEVER_WRITTEN_REASON)
    // A pure-chat turn never reaches this block: without a tool call there is
    // no evidence the task moved, and a clarifying question must stay free.
    if (turn?.toolUsed && Date.parse(lastWrittenAt) < turn.startedAt) {
      return this.block(token, turn, at, TLDR_STALE_REASON)
    }
    this.turns.delete(token)
    return {}
  }

  private block(token: string, turn: TurnState | undefined, at: number, reason: string): TldrHookOutput {
    this.turns.set(token, { startedAt: turn?.startedAt ?? at, toolUsed: turn?.toolUsed ?? false, blocked: true })
    return { decision: 'block', reason }
  }

  /** A revoked registration's process is gone; its unfinished turn must not
   * leak into the process that replaces it under a new token. */
  forget(token: string): void {
    this.turns.delete(token)
  }

  status(identities: readonly string[]): Record<string, TldrEnforcementStatus> {
    return Object.fromEntries(identities.map(identity => [identity, { hookContactAt: this.contact.get(identity) ?? null }]))
  }
}
