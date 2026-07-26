import { commandApplicable, surfaceApplicable } from '@renderer/features/command-palette/registry'
import type {
  CommandAvailability,
  CommandContext,
  CommandDef,
} from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// ADMISSION: may this invocation proceed, and if not, does the user get told?
//
// WHAT USED TO BE HERE, and why it is gone. Phase 2 also built target PINNING —
// `resolveCommandTarget`, `resolveCommandInvocation`, `targetStillValid`, and a
// `CommandDef.targetKind` field — to make a command resolve "which session?"
// once instead of three times.
//
// It never worked, and its own docstring said so: `CommandDef.run` takes only a
// context and has no target parameter, so `execute` called `run(ctx)` and every
// session command re-resolved its own target internally anyway. The pinned id
// was computed, carried, and then ignored at the one moment it mattered. No
// command ever set `targetKind`; nothing outside its own test file ever called
// any of it. It read as a safety mechanism while providing no safety, which is
// worse than its absence — a future reader would have trusted it.
//
// Where the real fix landed instead: at the mutation boundary, in the close
// gate (`closeConfirmation.ts`), which re-reads live state around its own await
// rather than trusting any snapshot taken at dispatch. That is the shape this
// problem actually has. Pinning at dispatch cannot help a command that mutates
// two seconds later; only re-reading at the mutation can, and a command that
// re-reads has no use for a pin.
//
// If target pinning returns, it has to start by threading the target INTO
// `run`. Anything short of that is this module again.
// ---------------------------------------------------------------------------

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
 *   3. A `getState` reporting `status('unavailable')` DISABLES with its own
 *      detail text. `commandState.ts` describes that variant as "what lets the
 *      picker grey a row instead of offering it as ordinary and executable" —
 *      but nothing enforced the second half, so a greyed "Unavailable" row ran
 *      normally on Enter. A state that says a capability is missing is a
 *      capability claim, not a decoration.
 *   4. A generic `when` / rendered-view failure hides, unexplained. Commands
 *      that deserve better opt in via step 2 or 3.
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

  const state = command.getState?.(ctx)
  if (state?.kind === 'status' && state.value === 'unavailable') {
    return { available: false, reason: state.detail, presentation: 'disable' }
  }

  return { available: true }
}

