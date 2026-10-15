import { useAppStore } from '@renderer/app-state/store'
import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { isSidekickSession } from '@renderer/workspace/sessionOwnership'
import { sidekickCommandTarget } from '@renderer/workspace/sidekickPanel'

/**
 * Is this command about to act on a sidekick? (#1493 follow-up.)
 *
 * Two ways to get a yes:
 *  - an explicit target (a context menu) that IS a sidekick row;
 *  - no explicit target while the Sidekick owns the keyboard — EVEN when it
 *    holds no row. commandTargetSessionIdForState answers null then, and a
 *    null target is where several lane commands fall back to something worse:
 *    Close Tab closes `activeTab`, the whole highlighted project.
 */
export function commandAddressesSidekick(ctx: Pick<CommandContext, 'workspace' | 'target'>): boolean {
  if (ctx.target !== undefined) return isSidekickSession(ctx.workspace.state.sessions[ctx.target])
  if (sidekickCommandTarget(ctx.workspace.state, useAppStore.getState()).owns) return true
  // Defensive: a target resolved some other way (a takeover naming a sidekick
  // row) still counts.
  const sessionId = commandTarget(ctx)
  return sessionId !== null && isSidekickSession(ctx.workspace.state.sessions[sessionId])
}

/**
 * Commands that mean "a LANE or PROJECT agent", hidden and refused whenever
 * they would act on a sidekick. Everything else that acts on the command
 * target works on the sidekick as it does on a lane (the inventory behind this
 * list is in docs/plans/2026-10-14-sidekick-global-agents.md, "lane parity").
 *
 * WHY each is here — what it would do to a sidekick:
 *  - close-tab: a sidekick has no projectId, so it closed the ACTIVE project
 *    and every session in it. Data loss; the reason this list exists.
 *  - pin-agent: pins are a Dispatch-index concept (plan I5); pinSession
 *    silently refuses, so the row was a dead entry.
 *  - toggle-reader-mode: Reader is keyed to a project tab and found none — a
 *    silent no-op. (Sidekick Spotlight solved the same problem for Spotlight;
 *    Reader for a sidekick is a follow-up, not a quiet failure.)
 *  - linked-agent: needs the parent's project tab ("parent tab not found"), and
 *    its placement overlay renders under Sidekick Spotlight's hidden lanes.
 *  - duplicate-agent: with no projectId it fell through to a LANE spawn, so
 *    the "copy" landed in the focused lane's project with cwd ~.
 *  - resume-session / search-conversation-prompts: they replace the commanded
 *    agent with a picked conversation from ANY repo; inheritedMembership keeps
 *    `sidekickId`, so the sidekick silently became that repo's agent. The
 *    Sidekick Picker is how a sidekick switches conversations.
 *  - browser pocket (7): the Sidekick leaf has no pocket placement, so pocket
 *    state was written with no UI, into a lane-oriented, project-shared jar.
 */
export const SIDEKICK_EXCLUDED_COMMAND_IDS: ReadonlySet<string> = new Set([
  'close-tab',
  'pin-agent',
  'toggle-reader-mode',
  'linked-agent',
  'duplicate-agent',
  'resume-session',
  'search-conversation-prompts',
  'toggle-browser-pocket',
  'reload-browser-pocket',
  'focus-browser-pocket-address',
  'pick-browser-pocket-element',
  'open-browser-pocket-external',
  'open-browser-pocket-devtools',
  'detach-browser-pocket',
])

/**
 * Wrap the listed commands' `when` so they are hidden from the palette and
 * refused at admission (resolveCommandAvailability) for a sidekick target —
 * one place for the rule, instead of fourteen hand-edited predicates that the
 * next lane command would forget.
 */
export function excludeSidekickTargets(commands: readonly CommandDef[]): CommandDef[] {
  return commands.map(command => {
    if (!SIDEKICK_EXCLUDED_COMMAND_IDS.has(command.id)) return command
    const when = command.when
    return {
      ...command,
      when: (ctx: CommandContext) => !commandAddressesSidekick(ctx) && (when ? when(ctx) : true),
    }
  })
}
