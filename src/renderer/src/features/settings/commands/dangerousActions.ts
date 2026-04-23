import type { CommandContext } from '@renderer/features/command-palette/types'

async function setDangerousAgentsAndReload(
  ctx: CommandContext,
  enabled: boolean,
): Promise<void> {
  if (ctx.flags.dangerousAgentsEnabled === enabled) return
  ctx.ui.setDangerousAgentsEnabled(enabled)
  ctx.ui.closePalette()
  await ctx.workspace.reloadAgentSessions(enabled)
}

export async function enableDangerousAgents(ctx: CommandContext): Promise<void> {
  await setDangerousAgentsAndReload(ctx, true)
}

export async function disableDangerousAgents(ctx: CommandContext): Promise<void> {
  await setDangerousAgentsAndReload(ctx, false)
}

export async function toggleDangerousAgents(ctx: CommandContext): Promise<void> {
  await setDangerousAgentsAndReload(ctx, !ctx.flags.dangerousAgentsEnabled)
}
