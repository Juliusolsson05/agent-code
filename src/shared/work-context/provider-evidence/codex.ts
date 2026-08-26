import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'
import type { WorktreeActivityEventSeed } from '@shared/work-context/provider-evidence/types.js'
import {
  classifyCommand,
  confidenceForKind,
} from '@shared/work-context/scoring.js'

/**
 * Convert only recognized Codex envelopes into worktree evidence.
 *
 * WHY this is discriminator-driven instead of recursively searching for cwd
 * or path fields: completed MCP calls can contain the cwd of a child agent or
 * target tool. Treating that nested value as the caller's location is exactly
 * the kind of plausible shortcut that silently moves the wrong agent between
 * worktrees. Every branch here corresponds either to a retained legacy Codex
 * carrier or to a current carrier measured in the recorded fixture corpus.
 */
export function extractCodexWorktreeActivitySeeds(
  record: Record<string, unknown>,
): WorktreeActivityEventSeed[] {
  const payload = asRecord(record.payload)

  // WHY return from one discriminator branch instead of accumulating several
  // helper arrays: this function runs for every JSONL record during a cache
  // rebuild, including the many records that carry no worktree evidence. A
  // cascade of `push(...helper())` calls allocated multiple empty arrays per
  // irrelevant line. The provider grammar is mutually exclusive at these
  // outer discriminators, so one branch is both easier to audit and bounded to
  // a single short-lived result array.
  if (record.type === 'session_meta') {
    const cwd = stringField(payload, 'cwd')
    if (!cwd) return []
    const git = asRecord(payload?.git)
    return [sessionCwdSeed({
      source: 'codex:session_meta.cwd',
      path: cwd,
      branch: stringField(git, 'branch'),
    })]
  }

  if (record.type === 'turn_context') {
    const cwd = stringField(payload, 'cwd')
    return cwd
      ? [sessionCwdSeed({ source: 'codex:turn_context.cwd', path: cwd })]
      : []
  }

  if (record.type === 'event_msg') {
    if (payload?.type === 'thread_settings_applied') {
      const settings = asRecord(payload.thread_settings)
      const cwd = stringField(settings, 'cwd')
      return cwd
        ? [sessionCwdSeed({ source: 'codex:thread_settings.cwd', path: cwd })]
        : []
    }
    if (payload?.type === 'item_completed') {
      return currentCompletedItemSeeds(payload)
    }
    if (payload?.type === 'exec_command_end') {
      return legacyCommandSeed(payload, 'codex:exec_command_end.cwd', 'cwd')
    }
    if (payload?.type === 'exec_approval_request') {
      return legacyCommandSeed(
        payload,
        'codex:exec_approval_request.workdir',
        'workdir',
        'medium',
      )
    }
    return []
  }

  if (record.type !== 'response_item') return []

  if (payload?.type === 'local_shell_call') {
    const action = asRecord(payload.action)
    const cwd =
      stringField(action, 'working_directory') ??
      stringField(action, 'workdir')
    if (!cwd) return []
    const command = commandFromAction(action)
    const kind = classifyCommand(command)
    return [{
      kind,
      source: 'codex:local_shell_call.cwd',
      path: cwd,
      branch: null,
      confidence: 'medium',
      active: true,
      command: command ?? undefined,
    }]
  }

  if (payload?.type === 'function_call') {
    return functionCallSeeds(payload)
  }

  return []
}

function currentCompletedItemSeeds(
  payload: Record<string, unknown>,
): WorktreeActivityEventSeed[] {
  const item = asRecord(payload.item)
  if (item?.type === 'CommandExecution') {
    const cwd = stringField(item, 'cwd')
    if (!cwd) return []
    const command = commandFromPayload(item)
    const kind = classifyCommand(command)
    return [{
      kind,
      source: 'codex:item_completed:CommandExecution.cwd',
      path: cwd,
      branch: null,
      confidence: kind === 'verification' ? 'medium' : 'strong',
      active: true,
      requiresWorktreeMatch: true,
      command: command ?? undefined,
    }]
  }

  if (item?.type === 'FileChange') {
    const changes = asRecord(item.changes)
    if (!changes) return []

    // WHY object keys are the evidence boundary: all 830 measured current
    // FileChange records use an object keyed by absolute changed path. There
    // is no recorded array variant to support, and accepting invented shapes
    // would make the parser appear future-proof while weakening our ability
    // to notice an actual upstream grammar change.
    return Object.keys(changes).map(path => ({
      kind: 'file-write',
      source: 'codex:item_completed:FileChange.changes',
      path,
      branch: null,
      confidence: 'strong',
      active: true,
      requiresWorktreeMatch: true,
      filePaths: [path],
    }))
  }

  // McpToolCall deliberately lands here. Its nested arguments describe the
  // invoked tool, not the Codex caller, so it is explicit non-evidence.
  return []
}

function legacyCommandSeed(
  payload: Record<string, unknown>,
  source: string,
  cwdField: string,
  confidenceOverride?: 'medium',
): WorktreeActivityEventSeed[] {
  const cwd = stringField(payload, cwdField)
  if (!cwd) return []
  const command = commandFromPayload(payload)
  const kind = classifyCommand(command)
  return [{
    kind,
    source,
    path: cwd,
    branch: null,
    confidence: confidenceOverride ??
      (kind === 'verification' ? 'medium' : 'strong'),
    active: true,
    command: command ?? undefined,
  }]
}

function sessionCwdSeed(params: {
  source: string
  path: string
  branch?: string | null
}): WorktreeActivityEventSeed {
  return {
    kind: 'session-cwd',
    source: params.source,
    path: params.path,
    branch: params.branch ?? null,
    confidence: 'medium',
    active: true,
    requiresWorktreeMatch: true,
  }
}

function functionCallSeeds(
  payload: Record<string, unknown>,
): WorktreeActivityEventSeed[] {
  const name = stringField(payload, 'name')
  if (!name) return []
  const args = parseJsonRecord(stringField(payload, 'arguments'))
  if (!args) return []

  const cwd =
    stringField(args, 'workdir') ??
    stringField(args, 'cwd') ??
    stringField(args, 'working_directory')
  const command = commandFromPayload(args)

  if (name === 'exec_command' && cwd) {
    const kind = classifyCommand(command)
    return [{
      kind,
      source: 'codex:function_call.workdir',
      path: cwd,
      branch: null,
      confidence: 'medium',
      active: true,
      command: command ?? undefined,
    }]
  }

  const filePath = stringField(args, 'file_path') ?? stringField(args, 'path')
  if (filePath?.startsWith('/')) {
    const kind = isWriteTool(name) ? 'file-write' : 'file-read'
    return [{
      kind,
      source: `codex:function_call:${name}:path`,
      path: filePath,
      branch: null,
      confidence: confidenceForKind(kind),
      active: true,
      requiresWorktreeMatch: true,
      filePaths: [filePath],
    }]
  }

  return []
}

function commandFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.command === 'string') return payload.command
  if (Array.isArray(payload.command)) {
    return payload.command
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
  }
  if (Array.isArray(payload.parsed_cmd)) {
    return payload.parsed_cmd
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
  }
  return null
}

function commandFromAction(action: Record<string, unknown> | null): string | null {
  if (!action) return null
  if (typeof action.command === 'string') return action.command
  if (Array.isArray(action.command)) {
    return action.command
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
  }
  if (Array.isArray(action.cmd)) {
    return action.cmd
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
  }
  return null
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit' ||
    toolName === 'apply_patch'
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
