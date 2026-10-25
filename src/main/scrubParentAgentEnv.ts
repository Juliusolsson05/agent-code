// Strip the per-session markers a parent Claude Code process puts on its
// children, so Agent Code never passes them on to the agents it spawns.
//
// WHY this exists (debug bundle f204f24f, 2026-10-25, Claude Code 2.1.310):
// Agent Code is often (re)started BY an agent — e.g. a release agent running
// `open "/Applications/Agent Code.app"` from its Bash tool. Claude Code gives
// every child process the variables in `NAMES` below (from the binary's own
// child-env builder, `vJe` in 2.1.310: CLAUDECODE, CLAUDE_CODE_SESSION_ID,
// CLAUDE_CODE_CHILD_SESSION, ...), so the whole Electron app inherited them,
// and then every `claude` we spawned inherited them too. Since 2.1.310 a
// `claude` that sees CLAUDE_CODE_CHILD_SESSION assumes it is a throwaway
// sub-run and turns transcript saving OFF ("⚠ Transcript saving is off —
// inherited CLAUDE_CODE_CHILD_SESSION marker"). Our feed reads the user prompt
// back from that transcript, so the prompt never came back: the pending row
// was dropped when the send settled and the conversation lost the user turn.
// The same leak also pointed every child at the PARENT's session id, PID and
// messaging socket, and CLAUDE_EFFORT would silently override effort.
//
// WHY scrub process.env at startup rather than in each provider's spawn:
// every provider (Claude, Codex, OpenCode, Grok, Pi), terminal, hook and MCP
// child copies `process.env`. Cleaning it once here fixes all of them, and
// future spawn sites can't forget. Nothing in Agent Code needs to know which
// agent launched the app.
//
// WHY an explicit list and not every `CLAUDE_CODE_*` / `CLAUDE_*` variable:
// many of those are user configuration that must reach the children
// (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CONFIG_DIR,
// ...). Only per-session markers are removed. When a new Claude Code release
// adds a marker, look for the object literal containing
// `CLAUDE_CODE_CHILD_SESSION:"1"` in the installed binary
// (`strings -n 20 ~/.local/share/claude/versions/<v> | grep ...`) and update
// this list.
//
// Must be imported straight after `loadEnv` at the top of
// `src/main/index.ts`, before any module captures `process.env`.

export const PARENT_AGENT_ENV_NAMES = [
  // Set by Claude Code for every child process (vJe in 2.1.310).
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'AI_AGENT',
  'CLAUDE_EFFORT',
  'TRACEPARENT',
  // Also seen in the inherited Agent Code env from the same parent; all
  // point at the parent session, not at anything we start.
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_INVOKED_SKILLS',
] as const

export function scrubParentAgentEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = []
  for (const name of PARENT_AGENT_ENV_NAMES) {
    if (env[name] === undefined) continue
    delete env[name]
    removed.push(name)
  }
  return removed
}

const removed = scrubParentAgentEnv(process.env)
if (removed.length > 0) {
  // One startup line so a future bundle shows the app was launched from an
  // agent; values are never logged (the messaging token is a secret).
  console.log(`[agent-code] removed inherited parent-agent env: ${removed.join(', ')}`)
}
