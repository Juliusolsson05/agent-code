import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'

export type DiscoveryKind = 'search' | 'read' | 'list'
export type DiscoveryProtocolId = `command.${DiscoveryKind}`

/**
 * The provider-neutral object painted for proven discovery work.
 *
 * WHY this wraps CommandRenderModel instead of copying its fields: command
 * normalization already owns status honesty, output bounding, cwd display,
 * and correlated-result ownership. Discovery is a semantic refinement of
 * that proven operation, not a competing command parser. Keeping the command
 * model intact means a declined or newly specialized operation cannot lose a
 * byte merely because its headline vocabulary improved.
 */
export type DiscoveryRenderModel = {
  kind: DiscoveryKind
  protocolId: DiscoveryProtocolId
  command: CommandRenderModel
}
