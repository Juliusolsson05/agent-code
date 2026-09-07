// See docs/design/provider-switching.md for the cross-provider capacity and
// native-compaction invariants coordinated by this transaction.
import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { planConversationContext } from 'agent-transcript-parser'
import type {
  ConversationContextPlan,
  ConversationDocument,
  ShrinkReport,
} from 'agent-transcript-parser'

import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'

export type SwitchProviderRequest = {
  sourceKind: AgentProviderKind
  /**
   * The target is explicit because provider switching is not a binary toggle.
   * The optional fallback exists for one compatibility window with older
   * renderer callers and can only infer the historical Claude/Codex pair.
   */
  targetKind?: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
  sourceCwd?: string
  targetCwd?: string
  sourceSessionId?: string
  overflowPolicy?: 'compact' | 'fail' | 'truncate'
  /**
   * Partial so a caller can opt into ONE half of the policy without restating
   * the other; the missing half falls back to DEFAULT_SWITCH_CONTEXT_POLICY.
   */
  contextPolicy?: Partial<SwitchContextPolicy>
  /**
   * The renderer already confirmed that this switch may compact the live
   * source. Only meaningful on the opt-in path, and only read by the IPC layer,
   * which owns the native dialog; see src/main/ipc/provider.ts. It lives on the
   * request rather than in the runtime because a bulk switch confirms once for
   * a batch and then fans out one request per agent.
   */
  sourceCompactionConfirmed?: boolean
}

/**
 * What the host is allowed to spend to make a conversation portable.
 *
 * WHY this is a policy object on the request and not two booleans threaded
 * through the call: both flags answer the same question — "may this transaction
 * spend a live provider turn, and on which side?" — and they are chosen
 * together in one piece of UI. Splitting them invites a caller to set one and
 * forget the other, and the forgotten one is always the one that spends quota.
 *
 * `allowSourceTurns: false` is the default because the feature exists for the
 * case where the SOURCE is out of quota (#821): asking it to compact itself is
 * then guaranteed to fail, and it fails after `/compact` has already destroyed
 * the history the switch was trying to rescue.
 *
 * `compactOnArrival` is carried here rather than acted on here: arrival
 * compaction runs after pane replacement, which is strictly outside this
 * transaction (see docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
 * §"Arrival compaction"). This field is the record of what the user asked for,
 * for the renderer to act on once `replaceSession` returns.
 */
export type SwitchContextPolicy = {
  allowSourceTurns: boolean
  compactOnArrival: boolean
}

export const DEFAULT_SWITCH_CONTEXT_POLICY: SwitchContextPolicy = {
  allowSourceTurns: false,
  compactOnArrival: false,
}

/**
 * How the conversation was made to fit, for toasts and batch summaries.
 *
 * - `native` — nothing was lost: the history fit, or the source's own portable
 *   summary was reused (planner `ready` / `existing-compaction`).
 * - `raw` — a carrier the target cannot read was dropped and the plaintext
 *   records it claimed to replace were carried instead (planner `raw-history`).
 *   Nothing the target could have read was lost.
 * - `shrunk` — the deterministic ladder had to remove content; `shrinkSummary`
 *   says what.
 */
export type SwitchStrategy = 'native' | 'raw' | 'shrunk'

export type SwitchProviderResult =
  | {
      kind: 'switched'
      targetKind: AgentProviderKind
      targetProviderSessionId: string
      targetFilePath: string
      compactedBeforeSwitch: boolean
      truncatedBeforeSwitch: boolean
      strategy: SwitchStrategy
      /**
       * One line describing what the shrink ladder removed, or null when
       * nothing was removed. Design principle 3: no lossy step is silent, and
       * the host is the only layer that can put the loss in front of a user.
       */
      shrinkSummary: string | null
    }
  | {
      kind: 'source-empty'
      targetKind: AgentProviderKind
    }

export type ProviderSwitchProgress = {
  sourceSessionId: string
  phase: 'compacting' | 'summarizing' | 'shrinking' | 'projecting'
  message: string
}

export interface SwitchProviderRuntime {
  compactSource?: (
    request: SwitchProviderRequest,
    plan: Extract<ConversationContextPlan, {
      kind: 'requires-compaction' | 'requires-portable-handoff'
    }>,
  ) => Promise<ConversationDocument | void>
  onProgress?: (progress: ProviderSwitchProgress) => void
}

export async function switchProvider(
  request: SwitchProviderRequest,
  runtime: SwitchProviderRuntime = {},
): Promise<SwitchProviderResult> {
  const targetKind = request.targetKind ?? inferLegacyTarget(request.sourceKind)
  if (targetKind === request.sourceKind) {
    throw new Error(
      `switchProvider: target kind ${targetKind} equals source kind — nothing to switch`,
    )
  }

  const source = getHostTranscriptAdapter(request.sourceKind)
  const target = getHostTranscriptAdapter(targetKind)
  const sourceCwd = request.sourceCwd ?? request.cwd
  const targetCwd = request.targetCwd ?? request.cwd

  // WHY every switch passes through ConversationDocument: pairwise dispatch
  // made each new provider require translators to every existing provider.
  // Source and target adapters now know only their own formats. All decoding
  // and projection completes before write(), so an unsupported record or
  // failed profile cannot leave a partial target transcript on disk.
  let conversation = await source.read(
    sourceCwd,
    request.sourceProviderSessionId,
  )
  if (!conversation.entries.some(entry => entry.kind !== 'opaque')) {
    // OpenCode Terminal is intentionally born with a durable provider session:
    // its TUI needs a `ses_...` id before the PTY starts so crash recovery can
    // resume the same conversation. That means "has a provider id" no longer
    // implies "has submitted a turn", as it happened to for Claude and Codex.
    // Report the distinction to the renderer instead of manufacturing a blank
    // target transcript or throwing. The renderer already has the exact
    // lossless operation for this state: replace the empty pane while carrying
    // unsent composer state and MCP policy forward.
    return { kind: 'source-empty', targetKind }
  }

  // Target model resolution may be project-scoped (OpenCode merges a local
  // opencode config for cwd), so capacity planning and projection must inspect
  // the same destination directory the imported session will run in.
  const targetProfile = await target.targetProfile(targetCwd)
  const policy: SwitchContextPolicy = { ...DEFAULT_SWITCH_CONTEXT_POLICY, ...request.contextPolicy }
  let compactedBeforeSwitch = false
  let truncatedBeforeSwitch = false
  let strategy: SwitchStrategy = 'native'
  let shrinkSummary: string | null = null
  const overflowPolicy = request.overflowPolicy ?? 'compact'

  // WHY `truncate` joins the default path but `fail` does not, when neither
  // spends a source turn:
  //
  // `truncate` asked for "fit it lossily rather than involve the source". That
  // is precisely what the ladder does, and it does it better than the old
  // `fitConversationToCharacterBudget` call it replaces — which could only drop
  // whole turns, and refused outright when an encrypted Codex carrier was in
  // the way (the exact shape #821 is about). Routing it here is a strict
  // upgrade for every caller that passed it.
  //
  // `fail` asked for the opposite: "refuse an oversized switch, do not make it
  // fit". Honouring the default policy there would silently turn a caller's
  // explicit refusal into a successful lossy switch, so it keeps the legacy
  // branch and its contextOverflowError. It is the only overflowPolicy value
  // whose meaning survives the new default unchanged.
  const planWithoutSourceTurns = overflowPolicy === 'truncate'
    || (overflowPolicy !== 'fail' && !policy.allowSourceTurns)

  if (planWithoutSourceTurns) {
    // WHY the source is never consulted on this path: the whole point of the
    // policy is that the source may be out of quota. The parser returns only
    // outcomes the host can execute alone; a ConversationUnfittableError is
    // the single legitimate failure and it aborts before any write.
    const plan = planConversationContext(
      conversation,
      targetKind,
      targetProfile.budgetCharacters,
      { allowSourceTurns: false },
    )
    if (plan.kind === 'shrunk') {
      strategy = 'shrunk'
      shrinkSummary = describeShrink(plan.report)
      // WHY every rung counts and not just `droppedTurns`, which is the most
      // obvious reading of "was history truncated":
      //
      // The flag's only job is to tell a caller that this switch LOST
      // something, and every rung of the ladder loses something. Rung 4 cuts
      // back to the nearest safe resume boundary, and the entries between the
      // old start and that boundary need not contain a single user message — a
      // decoded `claude-sequence-oversized-turns` at a quarter of its own size
      // drops 130 entries and zero complete turns. Rungs 2 and 3 keep every
      // entry but replace tool outputs with placeholders and trim tool inputs,
      // which is just as lossy from the target agent's point of view: it can
      // still see that a command ran, and can no longer see what it printed.
      // Rung 1 strips carriers the target could not have read, which is the
      // one arguably-free step — but it only ever runs alongside the others,
      // so including it costs nothing and keeps the expression readable as
      // "the ladder removed anything at all".
      const report = plan.report
      truncatedBeforeSwitch = report.strippedCompactions
        + report.clearedResults
        + report.trimmedInputs
        + report.droppedEntries > 0
      if (request.sourceSessionId) {
        runtime.onProgress?.({
          sourceSessionId: request.sourceSessionId,
          phase: 'shrinking',
          message: `History exceeds ${targetKind}; ${shrinkSummary}`,
        })
      }
    } else if (plan.kind === 'raw-history') {
      strategy = 'raw'
    }
    conversation = plan.conversation
  } else {
    let plan = planConversationContext(
      conversation,
      targetKind,
      targetProfile.budgetCharacters,
    )
    if (plan.kind === 'requires-compaction' || plan.kind === 'requires-portable-handoff') {
      if (overflowPolicy === 'fail') {
        throw contextOverflowError(plan.estimatedCharacters, targetProfile.budgetCharacters)
      }
      if (!request.sourceSessionId || !runtime.compactSource) {
        throw new Error(
          'Provider switch requires native compaction, but no live source session is available.',
        )
      }
      const requiresNativeCompaction = plan.kind === 'requires-compaction'
      runtime.onProgress?.(requiresNativeCompaction
        ? {
            sourceSessionId: request.sourceSessionId,
            phase: 'compacting',
            message: `Conversation is too large for ${targetKind}. Compacting before switch…`,
          }
        : {
            sourceSessionId: request.sourceSessionId,
            phase: 'summarizing',
            message: `Creating a portable handoff for ${targetKind}…`,
          })
      const compactedConversation = await runtime.compactSource(request, plan)
      compactedBeforeSwitch = requiresNativeCompaction
      conversation = compactedConversation ?? await source.read(
        sourceCwd,
        request.sourceProviderSessionId,
      )
      plan = planConversationContext(
        conversation,
        targetKind,
        targetProfile.budgetCharacters,
      )
      if (plan.kind === 'requires-compaction' || plan.kind === 'requires-portable-handoff') {
        throw new Error(
          `${request.sourceKind} context preparation completed, but the conversation is still not portable within the ${targetKind} target budget.`,
        )
      }
    }
    conversation = plan.conversation
  }

  if (request.sourceSessionId) {
    runtime.onProgress?.({
      sourceSessionId: request.sourceSessionId,
      phase: 'projecting',
      message: `Preparing ${targetKind} resume…`,
    })
  }
  const projection = await target.projectNativeResume(conversation, {
    cwd: targetCwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
    targetProfile,
  })
  const targetProviderSessionId = target.sessionId(projection.values)
  const targetFilePath = await target.write(targetCwd, projection.values)

  return {
    kind: 'switched',
    targetKind,
    targetProviderSessionId,
    targetFilePath,
    compactedBeforeSwitch,
    truncatedBeforeSwitch,
    strategy,
    shrinkSummary,
  }
}

/**
 * Turn a ShrinkReport into one line a user can read in a toast.
 *
 * WHY the host formats this rather than the parser: the parser deliberately
 * reports numbers and never prose — it does not know whether its caller is a
 * CLI, a log line or a toast, and a package that ships user-facing English
 * becomes the place every host has to work around. This is also why the
 * function reads only the report's stable counters and never `promptIndexLength`
 * or `retainedDeveloperMessages`: those describe the marker's internals, which
 * the ladder is still free to reshape.
 *
 * WHY `droppedEntries` gets its own clause instead of only `droppedTurns`:
 * rung 4 cuts back to the nearest safe resume boundary, so it can drop a long
 * run of assistant and tool entries without crossing a single user message.
 * Reporting "no changes" for a switch that just dropped 130 entries would break
 * design principle 3 (no lossy step is silent) in exactly the case the user is
 * least likely to notice on their own.
 */
export function describeShrink(report: ShrinkReport): string {
  const parts: string[] = []
  if (report.strippedCompactions > 0) {
    parts.push(`${report.strippedCompactions} encrypted compaction${report.strippedCompactions === 1 ? '' : 's'} dropped`)
  }
  if (report.clearedResults > 0) parts.push(`${report.clearedResults} tool outputs cleared`)
  if (report.trimmedInputs > 0) parts.push(`${report.trimmedInputs} tool inputs trimmed`)
  if (report.droppedTurns > 0) {
    parts.push(`${report.droppedTurns} oldest turns dropped`)
  } else if (report.droppedEntries > 0) {
    parts.push(`${report.droppedEntries} oldest entries dropped`)
  }
  const kb = (n: number): string => `${Math.round(n / 1000)}k`
  return `${parts.join(', ') || 'no changes'} (${kb(report.estimatedCharactersBefore)} → ${kb(report.estimatedCharactersAfter)} chars)`
}

function contextOverflowError(estimated: number, budget: number): Error {
  return new Error(
    `Provider switch requires compaction: estimated context ${estimated} characters exceeds target budget ${budget}.`,
  )
}

function inferLegacyTarget(source: AgentProviderKind): AgentProviderKind {
  if (source === 'claude') return 'codex'
  if (source === 'codex') return 'claude'
  throw new Error(
    `switchProvider: targetKind is required when switching from provider "${source}"`,
  )
}
