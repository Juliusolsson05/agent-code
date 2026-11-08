import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

// The external operator is intentionally not one of Agent Code's per-session
// MCP domains. Reserve its published name at the last provider launch boundary,
// including resume/recovery, so a global user configuration cannot hand every
// managed agent the controls for its siblings and parent app. This policy does
// not edit user files or disable unrelated MCP servers.
export const EXTERNAL_OPERATOR_SERVER_NAME = 'agent-code-control'
// Folder name = frontmatter name of operator-skills/agent-code-computer-execution.
// Claude keys skillOverrides and Codex keys name rules by this value.
export const EXTERNAL_OPERATOR_SKILL_NAME = 'agent-code-computer-execution'

// Codex requires a transport even for a disabled entry. Supplying a disabled
// HTTP placeholder handles both an absent global entry and our documented HTTP
// connection. A conflicting stdio entry under this reserved name fails Codex's
// config validation rather than connecting it. No bearer is supplied or read.
export const DISABLED_CODEX_EXTERNAL_CONTROL = {
  mcp_servers: { [EXTERNAL_OPERATOR_SERVER_NAME]: { enabled: false, url: 'http://127.0.0.1:1/disabled-agent-code-control' } },
} as const

export function disabledExternalOperatorSkill(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const path = resolve(codexHome, 'skills', EXTERNAL_OPERATOR_SKILL_NAME, 'SKILL.md')
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

export function excludeExternalControlFromClaude(args: string[], settings: Record<string, unknown> = {}): void {
  // Claude merges deniedMcpServers from all settings scopes, including this
  // launch-only --settings source. Unlike --strict-mcp-config, a named deny
  // retains unrelated user/project MCP integrations. Source: Claude's
  // services/mcp/config.ts getMcpDenylistSettings + isMcpServerDenied and
  // https://code.claude.com/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists
  //
  // WHY other launch settings are merged in here rather than pushed as their
  // own flag: the CLI takes one `--settings` value. A second flag carrying, say,
  // TLDR hooks would displace this denylist and quietly hand the external
  // operator MCP back to every agent. The deny is spread last so a caller's
  // fragment can never overwrite it.
  //
  // The operator SKILL needs its own deny since #1539: Settings now installs it
  // in ~/.claude/skills for the external Claude client, and every internal
  // Claude agent reads that same directory. `skillOverrides` (Claude Code
  // 2.1.319 settings schema: "on" | "name-only" | "user-invocable-only" |
  // "off") with "off" hides it from both the model and the slash menu.
  // policySettings and flagSettings are consulted before user/project settings
  // (the binary's `["policySettings","flagSettings"]` precedence list), so
  // this launch-only value beats a user's own `"on"`. Older CLIs that predate
  // the key ignore unknown settings keys; there the MCP deny above still
  // removes the tools the skill describes, leaving a skill that can do nothing.
  const overrides = settings.skillOverrides && typeof settings.skillOverrides === 'object' ? settings.skillOverrides : {}
  args.push('--settings', JSON.stringify({
    ...settings,
    deniedMcpServers: [{ serverName: EXTERNAL_OPERATOR_SERVER_NAME }],
    skillOverrides: { ...overrides, [EXTERNAL_OPERATOR_SKILL_NAME]: 'off' },
  }))
}

export function excludeExternalControlFromOpencode(env: Record<string, string>): void {
  const existing: unknown = env.OPENCODE_CONFIG_CONTENT?.trim() ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {}
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('OPENCODE_CONFIG_CONTENT must be an object')
  const root = existing as Record<string, unknown>
  if (root.mcp !== undefined && (!root.mcp || typeof root.mcp !== 'object' || Array.isArray(root.mcp))) throw new Error('OPENCODE_CONFIG_CONTENT.mcp must be an object')
  // OpenCode explicitly accepts {enabled:false} for an MCP entry. The highest
  // precedence inline config overrides inherited remote/local definitions.
  //
  // The SKILL needs its own deny since #1539: OpenCode also scans
  // ~/.claude/skills (unless OPENCODE_DISABLE_CLAUDE_CODE_SKILLS), which is
  // exactly where Settings now installs the operator skill for the external
  // Claude client. OpenCode 1.18.32's Skill.available drops any skill whose
  // `evaluate("skill", name, permission)` is "deny", both from the system
  // prompt list and from the skill tool. Rules resolve last-match-wins, so our
  // name key is appended after whatever the inherited config already had,
  // and a string `skill` rule (one action for every skill) becomes the "*"
  // entry so its meaning is kept for all other skills.
  // We do NOT set OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: that would hide every
  // skill the user installed for Claude, not just ours.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...root,
    mcp: { ...(root.mcp as object ?? {}), [EXTERNAL_OPERATOR_SERVER_NAME]: { enabled: false } },
    permission: withSkillDenied(root.permission),
  })
}

function withSkillDenied(permission: unknown): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  // A bare string is OpenCode's "this action for every permission" shorthand.
  const base: Record<string, unknown> = typeof permission === 'string' ? { '*': permission } : isRecord(permission) ? permission : {}
  const skill = base.skill
  const skillRules: Record<string, unknown> = typeof skill === 'string' ? { '*': skill } : isRecord(skill) ? { ...skill } : {}
  delete skillRules[EXTERNAL_OPERATOR_SKILL_NAME]
  return { ...base, skill: { ...skillRules, [EXTERNAL_OPERATOR_SKILL_NAME]: 'deny' } }
}
