import type { BuiltInMcpDomain } from '@mcp/shared/types'

/**
 * Root Agent Code Management (#906): one agent inside Agent Code is granted
 * the external operator's application-wide control catalog.
 *
 * WHY the two entry points share these constants: the command turns the
 * capability OFF directly and the confirmation dialog turns it ON after the
 * warning. If either path named a different domain or toast, the palette
 * badge, the pane toast and the MCP server's tool list could disagree about
 * whether the grant exists.
 */
export const ROOT_MANAGEMENT_DOMAIN: BuiltInMcpDomain = 'root_management'

export function rootManagementReloadLabels(enabled: boolean): { reloaded: string; failed: string } {
  return {
    reloaded: enabled
      ? 'Reloaded with Root Agent Code Management'
      : 'Reloaded without Root Agent Code Management',
    failed: 'Root Agent Code Management reload failed',
  }
}
