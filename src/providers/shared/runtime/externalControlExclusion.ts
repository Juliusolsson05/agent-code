import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

// The external operator is intentionally not one of Agent Code's per-session
// MCP domains. Reserve its published name at the last provider launch boundary,
// including resume/recovery, so a global user configuration cannot hand every
// managed agent the controls for its siblings and parent app. This policy does
// not edit user files or disable unrelated MCP servers.
export const EXTERNAL_OPERATOR_SERVER_NAME = 'agent-code-control'

// Codex requires a transport even for a disabled entry. Supplying a disabled
// HTTP placeholder handles both an absent global entry and our documented HTTP
// connection. A conflicting stdio entry under this reserved name fails Codex's
// config validation rather than connecting it. No bearer is supplied or read.
export const DISABLED_CODEX_EXTERNAL_CONTROL = {
  mcp_servers: { [EXTERNAL_OPERATOR_SERVER_NAME]: { enabled: false, url: 'http://127.0.0.1:1/disabled-agent-code-control' } },
} as const

export function disabledExternalOperatorSkill(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const path = resolve(codexHome, 'skills', 'agent-code-computer-execution', 'SKILL.md')
  // Internal agents can start BEFORE Settings installs the skill. Canonicalize
  // the deepest existing ancestor as well as an existing file: a symlinked
  // CODEX_HOME must yield the same exclusion before and after installation,
  // otherwise a running agent's later skill refresh could discover a new path.
  let ancestor = path
  while (true) {
    try { return { path: join(realpathSync(ancestor), relative(ancestor, path)), enabled: false } }
    catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return { path, enabled: false }
      ancestor = parent
    }
  }
}

export function excludeExternalControlFromCodex(args: string[], codexHome?: string): void {
  args.push('--config', `mcp_servers.${EXTERNAL_OPERATOR_SERVER_NAME}.enabled=false`,
    '--config', `mcp_servers.${EXTERNAL_OPERATOR_SERVER_NAME}.url="http://127.0.0.1:1/disabled-agent-code-control"`)
  // Skill rules are collected from User and SessionFlags layers separately
  // (codex core-skills/config_rules.rs), so this adds a session-only deny while
  // retaining unrelated user disables. Do not copy/edit the global skills list.
  const skill = disabledExternalOperatorSkill(codexHome)
  args.push('--config', `skills.config=[{path=${JSON.stringify(skill.path)},enabled=false}]`)
}

export function excludeExternalControlFromClaude(args: string[]): void {
  // Claude merges deniedMcpServers from all settings scopes, including this
  // launch-only --settings source. Unlike --strict-mcp-config, a named deny
  // retains unrelated user/project MCP integrations. Source: Claude's
  // services/mcp/config.ts getMcpDenylistSettings + isMcpServerDenied and
  // https://code.claude.com/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists
  args.push('--settings', JSON.stringify({ deniedMcpServers: [{ serverName: EXTERNAL_OPERATOR_SERVER_NAME }] }))
}

export function excludeExternalControlFromOpencode(env: Record<string, string>): void {
  const existing: unknown = env.OPENCODE_CONFIG_CONTENT?.trim() ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {}
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('OPENCODE_CONFIG_CONTENT must be an object')
  const root = existing as Record<string, unknown>
  if (root.mcp !== undefined && (!root.mcp || typeof root.mcp !== 'object' || Array.isArray(root.mcp))) throw new Error('OPENCODE_CONFIG_CONTENT.mcp must be an object')
  // OpenCode explicitly accepts {enabled:false} for an MCP entry. The highest
  // precedence inline config overrides inherited remote/local definitions.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...root, mcp: { ...(root.mcp as object ?? {}), [EXTERNAL_OPERATOR_SERVER_NAME]: { enabled: false } } })
}
