// Shared predicate: does this tool_use spawn a subagent the fleet row
// should own? (Residue plan P2c — the 2026-06-21 dispatch-name blind
// spot: a session spawning via the built-in MCP orchestration server
// painted ZERO Task cards while state-snapshot.subAgents held 73 tracked
// children, because the interception only knew 'Agent'/'spawn_agent'.)
//
// One predicate, consumed by Block.tsx (committed) and any future live
// dispatch, so the name list can never drift between planes again.
//
// mcp__<server>__orchestration_create_agent covers the claude MCP naming;
// bare orchestration_create_agent covers codex (its wire strips the mcp__
// prefix). wait/list/read orchestration tools are deliberately NOT here —
// they are queries about the fleet, not spawns, and render as JSON rows.
const SPAWN_NAMES = new Set(['Agent', 'spawn_agent', 'orchestration_create_agent'])

export function isAgentSpawnToolName(name: string): boolean {
  if (SPAWN_NAMES.has(name)) return true
  const m = /^mcp__[^]*__(.+)$/.exec(name)
  return m !== null && SPAWN_NAMES.has(m[1])
}
