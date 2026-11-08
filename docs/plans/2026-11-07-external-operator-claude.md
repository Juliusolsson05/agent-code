# External operator for Claude Code

Issue: #1539. Branch: `feat/external-claude-integration`.

## Problem

`createExternalControlSettings` takes one `integration` and the app wires only
`createExternalCodexIntegration`. External Claude Code users get no connection,
no operator skill, and a hand-copied config that goes stale whenever the port
or key changes.

## Evidence (Claude Code 2.1.319 binary + vendor/claude-code-src)

- User-scope MCP servers live in top-level `mcpServers` of
  `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`
  (vendor `utils/env.ts` getGlobalClaudeFile). `src/main/userMcp/nativeServers.ts`
  already mirrors this path.
- Claude writes that file through `saveConfigWithLock`. It takes a
  proper-lockfile lock (mkdir of `<file>.lock`, stale after 10s), re-reads the
  file and merges its updater onto the fresh copy. If we write under the same
  lock and keep the change small, Claude picks up our entry and never drops it.
- User skills: `join(CLAUDE_CONFIG_DIR || ~/.claude, 'skills', <name>, 'SKILL.md')`
  (vendor `skills/loadSkillsDir.ts`).
- Hiding the skill from internal agents: the 2.1.319 settings schema has
  `skillOverrides: Record<name, "on"|"name-only"|"user-invocable-only"|"off">`.
  `"off"` hides the skill from both the model and the user. policySettings and
  flagSettings are checked first (`wwe=["policySettings","flagSettings"]`), so
  our launch-only `--settings` wins over a user-scope override.

## Decisions

1. **Ownership by shape, not a marker.** JSON has no comments. The entry is
   app-owned only when it is exactly `{type:"http", url:"http://127.0.0.1:<port>/mcp",
   headers:{Authorization:"Bearer <64 hex>"}}`. That is also what our "Copy JSON
   Config" button and `claude mcp add --transport http … --header` produce, so
   adopting a hand-pasted copy is correct, not a takeover. Anything else under
   the reserved name is a conflict.
2. **Disable removes the entry.** Codex needs a disabled placeholder for tool
   policy. Claude keeps per-tool approvals in settings.json `permissions`, not
   in the server entry, so nothing worth keeping lives there.
3. **Per-client independence.** The settings owner reconciles each integration
   on its own and records each one's error. The listener stops only when every
   integration failed. This keeps the existing single-integration behaviour,
   where any failure stops the listener.
4. **Shared file primitives.** `readRegular` / `replaceObserved` / skill
   install move into `externalOperatorFiles.ts`, used by both clients. This is
   an in-scope cleanup, not a second abstraction.
5. **Internal exclusion.** `excludeExternalControlFromClaude` adds
   `skillOverrides[agent-code-computer-execution] = "off"`. The Claude
   skill-discovery panel adds the matching name rule.

6. **Per-client selection (owner request, 2026-11-07).** Settings has one
   switch per client (Codex, Claude Code), stored as `clients` in
   external-control.json. A settings file without that field means both
   clients, so existing Codex users also get Claude set up. Deselecting a
   client reconciles it with `null`, which removes our entry and skill.
   Only selected clients count towards the "every client failed" rule.
7. **No desktop-only mode.** The Codex desktop app and Claude Code in the
   Claude desktop app read the same global files as their CLIs, and no file is
   read by the desktop app alone. A selected client is reached in both, and
   Settings says so.

## Verification

- `tsc -b` + control-sdk project clean. Targeted vitest (settings, exclusion,
  claude runtime, renderer control/settings, agentSkills) is green.
- Live: wrote the entry into a throwaway CLAUDE_CONFIG_DIR. Real
  `claude mcp get agent-code-control` (2.1.319) reports it as a User config
  http server with the bearer header. Claude's own save of that file afterwards
  kept the entry.

## Steps

1. Extract shared file helpers; Codex integration uses them (no behaviour change).
2. `externalClaudeConfig.ts` (pure JSON transform) + `externalClaudeIntegration.ts`
   (lock + skill). Tests use synthetic `.claude.json` content.
3. `externalControl.ts`: integrations list, per-client status (`codex`, `claude`).
   Schema + Settings UI + guide/skill text.
4. Launch exclusion + skill panel rule + tests.
5. tsc (both projects) + targeted vitest; PR; release after merge approval.
