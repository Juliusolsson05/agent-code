// This list is intentionally finite even though several recorded structures use
// maps. Raw feed channel names and provider object keys are private input just as
// much as string values are; allowing arbitrary numeric-valued keys would let a
// prompt or path bypass the fixture publication gate by becoming a count label.
export const ALLOWED_WORKTREE_LIVE_FIXTURE_KEYS = new Set([
  "$fixture",
  "__render_shape",
  "block_completed",
  "block_started",
  "body_b64",
  "branch",
  "ch",
  "channel",
  "channelCounts",
  "cli_version",
  "client_metadata",
  "command",
  "content",
  "content-type",
  "cutoff",
  "cwd",
  "detached",
  "endpoint",
  "event",
  "events",
  "expected",
  "feedKindCounts",
  "file_path",
  "flow_selected",
  "ghost_orphan_sweep",
  "git",
  "gitBranch",
  "grid",
  "headers",
  "id",
  "input",
  "input_readiness",
  "item",
  "kind",
  "line",
  "main",
  "message",
  "method",
  "name",
  "optimistic_user_add",
  "optimistic_user_queue",
  "path",
  "payload",
  "process_state",
  "projectDir",
  "projection",
  "provider",
  "providerSessionId",
  "record",
  "recordedEncoding",
  "recording",
  "records",
  "role",
  "rootTurnId",
  "root_turn_id",
  "screen_update",
  "session:jsonl-error",
  "session:process-state",
  "session:screen",
  "session:semantic-event",
  "session:started",
  "session:transcript-diagnostic",
  "sessionId",
  "session_id",
  "session_started",
  "sourceFingerprint",
  "status",
  "stream_phase",
  "submit",
  "text_delta",
  "threadId",
  "thread_id",
  "timestamp",
  "tool_input_delta",
  "turn_completed",
  "turn_delta",
  "turn_started",
  "type",
  "ui",
  "usage_updated",
  "visible_rows",
  "workspace",
  "worktrees",
])

export function findRejectedWorktreeLiveFixtureKeys(value: unknown): string[] {
  const rejected: string[] = []
  const walk = (item: unknown, path: string): void => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }
    if (typeof item !== 'object' || item === null) return
    for (const [key, child] of Object.entries(item)) {
      const childPath = path ? `${path}.${key}` : key
      if (!ALLOWED_WORKTREE_LIVE_FIXTURE_KEYS.has(key)) {
        rejected.push(childPath)
      }
      walk(child, childPath)
    }
  }
  walk(value, '')
  return rejected
}
