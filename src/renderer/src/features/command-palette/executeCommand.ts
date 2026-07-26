import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { commandApplicable } from '@renderer/features/command-palette/registry'
import { recordCommandUse } from '@renderer/features/command-palette/lib/recentCommandHistory'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// THE COMMAND EXECUTION GATEWAY (governance plan, Phase 1).
//
// Before this module, the four ways to run a command had four different sets
// of guarantees:
//
//   palette      → surface + when + renderedView + picker visibility, then run
//   native menu  → looked the id up in the ALREADY-FILTERED picker list, so a
//                  cosmetic visibility preference could disable a File-menu
//                  item, and an inapplicable id silently did nothing
//   keybinding   → called workspace actions directly, skipping every predicate
//   programmatic → whatever the caller happened to do
//
// Two opposite failures fall out of that: a presentation preference could
// remove a capability, and a keyboard chord could bypass every capability
// check. Both are symptoms of the same root cause — the app had a picker
// resolver where it needed an admission authority.
//
// This module is that authority. Every invocation states its source, gets a
// FRESH admission check against current state, and produces an explicit
// outcome instead of a silent no-op. Picker visibility is deliberately absent
// from the entire file: discoverability cannot gate execution, by construction.
//
// WHAT THIS IS NOT: it is not a safety boundary for destructive work. Admission
// says "this invocation is sensible now"; it cannot say "the target still
// exists at the moment we mutate it". Per-command revalidation at the mutation
// boundary is Phase 2/7 work and is not made redundant by anything here.
// ---------------------------------------------------------------------------

/**
 * Where an invocation came from. Carried through the whole dispatch so history
 * policy and diagnostics can distinguish deliberate user action from machinery.
 */
export type CommandInvocationSource =
  /** The user picked a row in the command palette. */
  | 'palette'
  /** The user clicked an item in the native application menu. */
  | 'native-menu'
  /** The user pressed a configured chord. */
  | 'keybinding'
  /** App code, a background flow, or a test. Never a user signal. */
  | 'programmatic'

/**
 * Sources that represent a deliberate human action. Only these may influence
 * personalized ranking — otherwise a background caller could quietly promote a
 * command the user has never chosen to the top of their palette.
 */
const USER_SOURCES: ReadonlySet<CommandInvocationSource> = new Set([
  'palette',
  'native-menu',
  'keybinding',
])

export type CommandDispatchOutcome =
  /** Admitted and completed without throwing. The only outcome that counts as use. */
  | { status: 'ran'; id: string; source: CommandInvocationSource }
  /** No command with this id exists in the catalog. A menu/caller bug. */
  | { status: 'unknown'; id: string; source: CommandInvocationSource }
  /** The command exists but does not apply right now. */
  | { status: 'unavailable'; id: string; source: CommandInvocationSource }
  /** The command threw synchronously or its promise rejected. */
  | { status: 'failed'; id: string; source: CommandInvocationSource; error: unknown }
  /** An identical invocation was already in flight; this one was dropped. */
  | { status: 'in-flight'; id: string; source: CommandInvocationSource }

export type DispatchCommandOptions = {
  id: string
  source: CommandInvocationSource
  ctx: CommandContext
  /**
   * Surfaces a failure to the user. Optional because the gateway must remain
   * usable from a plain node test; when absent a failure is still REPORTED in
   * the return value, it just is not shown.
   *
   * WHY injected rather than importing a toast module: this file is pure and
   * React-free so admission and history policy can be tested without a DOM.
   * Reaching for `useGlobalToast` here would drag the renderer tree into every
   * test that wants to assert "a keybinding cannot bypass a capability gate".
   */
  reportError?: (message: string, error: unknown) => void
}

/**
 * A row the palette already holds, which may or may not correspond to a
 * catalog command. Structurally the part of `ResolvedCommand` this module
 * needs — typed structurally rather than importing `ResolvedCommand` so the
 * gateway does not depend on the palette's presentation shape.
 */
export type DispatchableRow = {
  id: string
  title: string
  run: (ctx: CommandContext) => void | Promise<void>
}

/**
 * In-flight ids, for single-flight protection.
 *
 * WHY module scope rather than per-context: identity here is the COMMAND, not
 * the component that dispatched it. A palette Enter and a native-menu click
 * naming the same id are the same operation and must collide; scoping to a
 * React tree would let them race — which is exactly how a double-spawn or a
 * double-kill happens.
 *
 * Only genuinely async commands can ever be blocked: a synchronous `run`
 * completes before the entry is read again, so this never interferes with
 * repeat-tapping a cheap toggle.
 */
const inFlight = new Set<string>()

/** Test seam: the in-flight set is module state, so a failing test must be
 *  able to leave it clean for the next one. Not used by product code. */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}

/**
 * Run a command from any source, with one set of guarantees for all of them.
 *
 * Always resolves; never rejects. A caller that forgets to await must not be
 * able to produce an unhandled rejection — the audit found fire-and-forget
 * `void command.run(ctx)` at every call site, which is how an async failure
 * became invisible.
 */
export async function dispatchCommand(
  options: DispatchCommandOptions,
): Promise<CommandDispatchOutcome> {
  const { id, source, ctx, reportError } = options

  // Resolve against the FULL catalog, never the picker-filtered registry.
  // This one line is the fix for the native-menu defect: hiding a command from
  // the palette can no longer make its menu item unresolvable.
  const command = findCommand(id)
  if (!command) {
    return { status: 'unknown', id, source }
  }

  // Fresh admission, evaluated now rather than when a list was last rendered.
  // The palette's rows can be a frame stale, a menu click arrives arbitrarily
  // late, and a chord bypassed these checks entirely before this existed.
  if (!commandApplicable(command, ctx)) {
    return { status: 'unavailable', id, source }
  }

  return runGuarded({
    id,
    source,
    ctx,
    reportError,
    label: commandLabel(command, ctx),
    run: command.run,
  })
}

/**
 * Dispatch a row the caller already holds.
 *
 * Exists for the palette, whose list mixes catalog commands with
 * `agent-index:<sessionId>` rows — transient "go to this agent" destinations
 * generated per keystroke, outside the static catalog, that no id lookup can
 * resolve.
 *
 * When the row IS a catalog command it gets the full treatment, including a
 * fresh admission check: the palette's memoized list can be a frame behind the
 * workspace, so the row the user pressed Enter on is not proof the command
 * still applies. When it is not, admission is skipped — there is no
 * `CommandDef` to consult — but error handling, single-flight, and history
 * policy still apply, so a transient row cannot become a hole in the
 * guarantees.
 */
export async function dispatchResolvedRow(options: {
  row: DispatchableRow
  source: CommandInvocationSource
  ctx: CommandContext
  reportError?: (message: string, error: unknown) => void
}): Promise<CommandDispatchOutcome> {
  const { row, source, ctx, reportError } = options
  const command = findCommand(row.id)

  if (command && !commandApplicable(command, ctx)) {
    return { status: 'unavailable', id: row.id, source }
  }

  return runGuarded({
    id: row.id,
    source,
    ctx,
    reportError,
    label: row.title,
    run: row.run,
  })
}

/**
 * The shared execution core: single-flight, error capture, history policy.
 *
 * Both public entry points funnel through here so there is exactly one place
 * that decides what "successfully ran" means. Two entry points with two copies
 * of this logic is how the palette and the menu drifted apart in the first
 * place.
 */
async function runGuarded(options: {
  id: string
  source: CommandInvocationSource
  ctx: CommandContext
  reportError?: (message: string, error: unknown) => void
  label: string
  run: (ctx: CommandContext) => void | Promise<void>
}): Promise<CommandDispatchOutcome> {
  const { id, source, ctx, reportError, label, run } = options

  if (inFlight.has(id)) {
    return { status: 'in-flight', id, source }
  }
  inFlight.add(id)

  try {
    // `await` covers both shapes: a sync `run` that throws rejects the
    // implicit promise, and an async one rejects normally. One catch handles
    // both, which is what makes "async rejection is never unhandled" true
    // rather than aspirational.
    await run(ctx)
  } catch (error) {
    reportError?.(`Command failed: ${label}`, error)
    return { status: 'failed', id, source, error }
  } finally {
    inFlight.delete(id)
  }

  // History is recorded ONLY here — after a successful, admitted, user-driven
  // run. Unavailable, unknown, in-flight, and failed invocations deliberately
  // do not count: personalized ranking should reflect what the user actually
  // accomplished, not what they attempted. Programmatic dispatch never counts
  // at all, so background machinery cannot reshape the palette.
  //
  // Transient agent-index rows are excluded too: their ids embed a session id
  // that can never rank a future palette open, so recording them would evict
  // real commands from a bounded history for no benefit.
  if (USER_SOURCES.has(source) && !isTransientRowId(id)) {
    recordCommandUse(id, source as 'palette' | 'native-menu' | 'keybinding')
  }

  return { status: 'ran', id, source }
}

/** Transient palette destinations, generated per keystroke outside the
 *  catalog. Kept as a prefix check here (rather than importing the palette's
 *  helper) so the gateway does not depend on the presentation layer. */
function isTransientRowId(id: string): boolean {
  return id.startsWith('agent-index:')
}

/**
 * Is this id runnable right now? Answers WITHOUT running it, for a caller that
 * needs to render an enabled/disabled affordance — notably the native menu,
 * which should be able to explain "unavailable" rather than click into nothing.
 *
 * Deliberately ignores picker visibility, for the same reason dispatch does.
 */
export function canDispatchCommand(id: string, ctx: CommandContext): boolean {
  const command = findCommand(id)
  return command ? commandApplicable(command, ctx) : false
}

function findCommand(id: string): CommandDef | undefined {
  return builtInCommandCatalog.find(candidate => candidate.id === id)
}

/** Human-readable label for an error message. Function titles need the context
 *  they were declared against, so resolve them rather than printing a raw id. */
function commandLabel(command: CommandDef, ctx: CommandContext): string {
  return typeof command.title === 'function' ? command.title(ctx) : command.title
}
