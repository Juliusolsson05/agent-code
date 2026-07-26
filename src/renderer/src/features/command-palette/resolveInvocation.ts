import { commandApplicable, surfaceApplicable } from '@renderer/features/command-palette/registry'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type {
  CommandAvailability,
  CommandContext,
  CommandDef,
  CommandTarget,
  ResolvedCommandInvocation,
} from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Phase 2: one invocation, one read of state.
//
// The audit's "target scope is invisible" and "target-sensitive commands
// independently resolve in when/getState/run" findings are the same bug seen
// from two angles. A command like `reload-agent` asked "which session?" three
// separate times — once to decide whether to appear, once to compute its
// badge, and once to actually reload. Nothing forced those three answers to
// agree, so a focus change between palette render and Enter could show you
// session A's provider badge and reload session B.
//
// This module resolves target, availability, state and execute TOGETHER, from
// a single read. They cannot disagree because they were never computed apart.
// ---------------------------------------------------------------------------

/**
 * What kind of target a command needs, defaulting from its surface.
 *
 * WHY derived rather than declared on all 30-odd session commands: `surface:
 * 'session'` ALREADY means "acts on the current command-target session, in
 * both Grid and Dispatch" — that is the field's documented definition. Making
 * every such command repeat the same `targetKind: 'session'` line would be
 * thirty edits that can drift out of agreement with the surface they sit next
 * to, and a new session command that forgot the line would silently resolve to
 * no target and skip pinning entirely.
 *
 * Everything else defaults to `'none'` and must OPT IN. That asymmetry is the
 * safe direction: a command that should have pinned a target and didn't is a
 * visible bug (it does nothing), while a command that pins a target it should
 * not have is an invisible one (it acts on the wrong thing).
 */
function declaredTargetKind(command: CommandDef): NonNullable<CommandDef['targetKind']> {
  if (command.targetKind) return command.targetKind
  return command.surface === 'session' ? 'session' : 'none'
}

/**
 * Pin the concrete thing this invocation acts on.
 *
 * A command that declares no `targetKind` resolves to `{kind: 'none'}` rather
 * than being handed whatever session happens to be focused. That asymmetry is
 * deliberate: the audit found app-scoped panel toggles reading the focused
 * session and rendering session-scoped state for a workspace-wide setting.
 * Inventing a target is worse than having none, because it produces a
 * confident wrong answer.
 */
export function resolveCommandTarget(
  command: CommandDef,
  ctx: CommandContext,
): CommandTarget {
  switch (declaredTargetKind(command)) {
    case 'session': {
      // The Dispatch-aware resolver is already the single source of truth for
      // "which session is the user visibly commanding". Note it returns null
      // for an empty or stale tiled lane BY DESIGN — that is an explicit "no
      // target", never a fallback to some other row.
      const id = commandTargetSessionId(ctx.workspace)
      return id ? { kind: 'session', id } : { kind: 'none' }
    }
    case 'project': {
      const id = ctx.flags.focusedCwd
      return id ? { kind: 'project', id } : { kind: 'none' }
    }
    case 'app':
      return { kind: 'app' }
    case 'document':
      // Declared for completeness (the plan's target union includes it), but
      // no command uses it yet and the Global Editor does not expose a stable
      // document identity to the command layer. Resolving to 'none' rather
      // than guessing keeps the honest answer honest; wire it when the first
      // consumer needs it AND the editor can supply an id.
      return { kind: 'none' }
    case 'none':
    default:
      return { kind: 'none' }
  }
}

/**
 * May this invocation proceed, and if not, should the user see why?
 *
 * Order is the product decision, not an implementation detail:
 *
 *   1. Surface mismatch HIDES. A grid-spatial command in Dispatch points at a
 *      layout the user cannot see; explaining that on every mode switch would
 *      be noise, not help.
 *   2. An explicit `unavailableReason` wins next, so a command can UPGRADE a
 *      silent hide into an explained disable. This is the "discovery-worthy"
 *      case: someone searching for Rewind on OpenCode deserves a greyed row
 *      saying why, not silence they cannot interpret.
 *   3. A generic `when` / rendered-view failure hides, unexplained. Commands
 *      that deserve better opt in via step 2.
 */
export function resolveCommandAvailability(
  command: CommandDef,
  ctx: CommandContext,
): CommandAvailability {
  if (!surfaceApplicable(command, ctx)) {
    return {
      available: false,
      reason: 'Not applicable in this layout',
      presentation: 'hide',
    }
  }

  const declared = command.unavailableReason?.(ctx)
  if (declared) {
    return { available: false, reason: declared.reason, presentation: declared.presentation }
  }

  if (!commandApplicable(command, ctx)) {
    return {
      available: false,
      reason: 'Not available right now',
      presentation: 'hide',
    }
  }

  return { available: true }
}

/**
 * Resolve everything about one invocation at once.
 *
 * `execute` closes over the TARGET RESOLVED HERE, not over "whatever is
 * focused when you call me". That closure is the mechanism that makes the
 * pinning real — a later focus change cannot retarget an invocation that
 * already captured its identity.
 */
export function resolveCommandInvocation(
  command: CommandDef,
  ctx: CommandContext,
): ResolvedCommandInvocation {
  const target = resolveCommandTarget(command, ctx)
  const availability = resolveCommandAvailability(command, ctx)

  return {
    commandId: command.id,
    target,
    availability,
    // State is computed only for a command that can actually run. Evaluating
    // `getState` for an excluded command was wasted work at best, and at worst
    // read a target that admission had just rejected.
    state: availability.available && command.getState ? command.getState(ctx) : null,
    execute: () => command.run(ctx),
  }
}

/**
 * MUTATION-BOUNDARY revalidation: is the pinned target still the thing we
 * think it is, right now?
 *
 * WHY this exists separately from admission: admission runs at dispatch. A
 * destructive command may await a confirmation modal, a provider probe, or a
 * kill round-trip before it mutates — and the target can vanish, move project,
 * or change provider in that window. Admission cannot cover that gap; only a
 * check at the moment of mutation can.
 *
 * Returns false rather than throwing, and callers must treat false as "reject
 * this operation", never as "fall back to the currently focused session".
 * Silently retargeting is the exact failure this is here to prevent: a
 * confirmation the user granted for agent A must never authorize killing B.
 */
export function targetStillValid(target: CommandTarget, ctx: CommandContext): boolean {
  switch (target.kind) {
    case 'session':
      // Re-read from the authoritative store rather than trusting a captured
      // snapshot. Presence in `sessions` is the minimum bar; per-command
      // checks (still grid-owned? still this provider? still running?) belong
      // with the command, which knows what its own invariant is.
      return Boolean(ctx.workspace.state.sessions[target.id])
    case 'project':
      return ctx.flags.focusedCwd === target.id
    case 'document':
      // No document identity is resolvable yet (see resolveCommandTarget), so
      // a document target can never have been pinned in the first place.
      return false
    case 'app':
    case 'none':
      // Nothing identity-bearing to invalidate.
      return true
  }
}
