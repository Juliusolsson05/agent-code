import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
import { classifyShellDiscovery } from '@providers/shared/renderer/protocols/discovery/classifyShellDiscovery'
import type { DiscoveryRenderModel } from '@providers/shared/renderer/protocols/discovery/model'

/** The sole composition boundary for shell-derived discovery semantics. */
export function composeDiscoveryOperation(
  command: CommandRenderModel,
  exactCommand: string,
): DiscoveryRenderModel | null {
  const kind = classifyShellDiscovery(exactCommand)
  if (!kind) return null
  return {
    kind,
    protocolId: `command.${kind}`,
    command,
  }
}
