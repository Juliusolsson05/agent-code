import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'

// WHY this lives in dangerousCommands.ts and not in a sibling
// dangerousActions module: there used to be a `dangerousActions` file
// that exported three runners (enable / disable / toggle) plus a shared
// helper, but only `toggleDangerousAgents` was ever wired into a
// CommandDef. Keeping the toggle next to its sole consumer collapses
// two files into one without losing the non-obvious sequencing
// constraint below: we MUST flip the flag, close the palette, then
// await reloadAgentSessions in that exact order. Reversing them races
// a still-visible palette against the reload and the new flag value
// never reaches the next-spawned agent session.
async function toggleDangerousAgents(ctx: CommandContext): Promise<void> {
  const next = !ctx.flags.dangerousAgentsEnabled
  if (ctx.flags.dangerousAgentsEnabled === next) return
  ctx.ui.setDangerousAgentsEnabled(next)
  ctx.ui.closePalette()
  await ctx.workspace.reloadAgentSessions(next)
}

export const dangerousCommands: CommandDef[] = [
  {
    id: 'dangerous-agents',
    surface: 'app',
    title: 'Dangerous Agents',
    description: '**What it does:** Toggles **dangerous agent mode** for future agents.\n\n**Use when:** You explicitly want agents to run with fewer safety restrictions.\n\n**Notes:** Affects new agent sessions, not existing ones.',
    getState: ({ flags }) => ({
      label: flags.dangerousAgentsEnabled ? 'On' : 'Off',
      tone: flags.dangerousAgentsEnabled ? 'danger' : 'neutral',
    }),
    run: toggleDangerousAgents,
  },
]
