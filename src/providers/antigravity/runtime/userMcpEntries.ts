import { claudeUserMcpEntries } from '@providers/shared/runtime/userMcpLaunch.js'
import type { ResolvedUserMcpServer } from '@shared/userMcp/types.js'
import { isStringArray, isStringRecord, providerSupportForEntry } from '@shared/userMcp/validate.js'

export type AntigravityUserMcpConfig =
  | { command: string; args: string[]; env: Record<string, string> }
  | { serverUrl: string; headers: Record<string, string> }

export function resolveAntigravityUserMcpEntries(servers: readonly ResolvedUserMcpServer[]): Array<{ name: string; config: AntigravityUserMcpConfig }> {
  // Both launchers receive the same already-approved entry. Reuse substitution so
  // missing secrets never turn into empty headers, and keep values on their own server.
  const { entries } = claudeUserMcpEntries(servers.filter(server => providerSupportForEntry(server.entry).antigravity.ok))
  const result: Array<{ name: string; config: AntigravityUserMcpConfig }> = []
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry.command === 'string') {
      result.push({ name, config: { command: entry.command, args: isStringArray(entry.args) ? entry.args : [], env: isStringRecord(entry.env) ? entry.env : {} } })
    } else if (typeof entry.url === 'string') {
      result.push({ name, config: { serverUrl: entry.url, headers: isStringRecord(entry.headers) ? entry.headers : {} } })
    }
  }
  return result
}
