import type { Entry } from '@shared/types/transcript'
import { isConversationEntry } from '@shared/types/transcript'
import type {
  WorkContextConfidence,
  WorktreeActivityEvent,
  WorktreeActivityKind,
} from '@shared/work-context/types'
import {
  classifyCommand,
  confidenceForKind,
  primaryWeightFor,
} from '@shared/work-context/scoring'

type EventSeed = Omit<WorktreeActivityEvent, 'key' | 'ts' | 'primaryWeight'> & {
  ts?: number
  primaryWeight?: number
}

export function extractWorktreeActivityEvents(
  raw: unknown,
  now = Date.now(),
): WorktreeActivityEvent[] {
  const record = asRecord(raw)
  if (!record) return []

  const seeds: EventSeed[] = []

  if (record.type === 'worktree-state') {
    const session = asRecord(record.worktreeSession)
    if (!session) {
      seeds.push({
        kind: 'worktree-exit',
        source: 'claude:worktree-state:exit',
        path: '',
        branch: null,
        confidence: 'explicit',
        active: true,
      })
    } else {
      const worktreePath = stringField(session, 'worktreePath')
      if (worktreePath) {
        seeds.push({
          kind: 'worktree-enter',
          source: 'claude:worktree-state',
          path: worktreePath,
          branch: stringField(session, 'worktreeBranch'),
          confidence: 'explicit',
          active: true,
        })
      }
    }
  }

  const codexPayload = asRecord(record.payload)
  if (record.type === 'event_msg' && codexPayload?.type === 'exec_command_end') {
    const cwd = stringField(codexPayload, 'cwd')
    if (cwd) {
      const command = commandFromPayload(codexPayload)
      const kind = classifyCommand(command)
      seeds.push({
        kind,
        source: 'codex:exec_command_end.cwd',
        path: cwd,
        branch: null,
        confidence: kind === 'verification' ? 'medium' : 'strong',
        active: true,
        command: command ?? undefined,
      })
    }
  }

  if (record.type === 'event_msg' && codexPayload?.type === 'exec_approval_request') {
    const cwd = stringField(codexPayload, 'workdir')
    if (cwd) {
      const command = commandFromPayload(codexPayload)
      const kind = classifyCommand(command)
      seeds.push({
        kind,
        source: 'codex:exec_approval_request.workdir',
        path: cwd,
        branch: null,
        confidence: 'medium',
        active: true,
        command: command ?? undefined,
      })
    }
  }

  if (record.type === 'response_item' && codexPayload?.type === 'local_shell_call') {
    const action = asRecord(codexPayload.action)
    const cwd =
      stringField(action, 'working_directory') ??
      stringField(action, 'workdir')
    if (cwd) {
      const command = commandFromAction(action)
      const kind = classifyCommand(command)
      seeds.push({
        kind,
        source: 'codex:local_shell_call.cwd',
        path: cwd,
        branch: null,
        confidence: 'medium',
        active: true,
        command: command ?? undefined,
      })
    }
  }

  if (record.type === 'response_item' && codexPayload?.type === 'function_call') {
    const events = functionCallEvents(codexPayload)
    seeds.push(...events)
  }

  seeds.push(...conversationToolEvents(record))

  const cwd = stringField(record, 'cwd')
  if (cwd && isConversationEntry(record as Entry)) {
    seeds.push({
      kind: 'session-cwd',
      source: 'claude:entry.cwd',
      path: cwd,
      branch: stringField(record, 'gitBranch'),
      confidence: 'medium',
      active: true,
      requiresWorktreeMatch: true,
      primaryWeight: 1,
    })
  }

  return seeds.map((seed, index) => {
    const ts = seed.ts ?? timestampMs(record, now)
    const primaryWeight = seed.primaryWeight ?? primaryWeightFor(seed.kind)
    return {
      ...seed,
      ts,
      primaryWeight,
      key: eventKey(seed, ts, index),
    }
  })
}

function functionCallEvents(payload: Record<string, unknown>): EventSeed[] {
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

function conversationToolEvents(record: Record<string, unknown>): EventSeed[] {
  if (!isConversationEntry(record as Entry)) return []
  const content = (record as Entry & { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []

  const events: EventSeed[] = []
  for (const block of content) {
    const b = asRecord(block)
    if (!b || b.type !== 'tool_use') continue
    const input = asRecord(b.input)
    if (!input) continue

    const toolName = stringField(b, 'name') ?? 'tool'
    const directPath =
      stringField(input, 'file_path') ??
      stringField(input, 'path') ??
      stringField(input, 'cwd') ??
      stringField(input, 'workdir')
    if (!directPath?.startsWith('/')) continue

    const kind = isWriteTool(toolName) ? 'file-write' : 'file-read'
    events.push({
      kind,
      source: `tool:${toolName}:path`,
      path: directPath,
      branch: null,
      confidence: confidenceForKind(kind),
      active: true,
      requiresWorktreeMatch: true,
      filePaths: [directPath],
    })
  }
  return events
}

function commandFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.command === 'string') return payload.command
  if (Array.isArray(payload.command)) {
    return payload.command.filter((part): part is string => typeof part === 'string').join(' ')
  }
  if (Array.isArray(payload.parsed_cmd)) {
    return payload.parsed_cmd.filter((part): part is string => typeof part === 'string').join(' ')
  }
  return null
}

function commandFromAction(action: Record<string, unknown> | null): string | null {
  if (!action) return null
  if (typeof action.command === 'string') return action.command
  if (Array.isArray(action.command)) {
    return action.command.filter((part): part is string => typeof part === 'string').join(' ')
  }
  if (Array.isArray(action.cmd)) {
    return action.cmd.filter((part): part is string => typeof part === 'string').join(' ')
  }
  return null
}

function eventKey(seed: EventSeed, ts: number, index: number): string {
  return [
    seed.source,
    seed.kind,
    ts,
    seed.path,
    seed.branch ?? '',
    seed.command ?? '',
    seed.filePaths?.join(',') ?? '',
    index,
  ].join('|')
}

function timestampMs(record: Record<string, unknown>, fallback: number): number {
  const timestamp = stringField(record, 'timestamp')
  if (!timestamp) return fallback
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit' ||
    toolName === 'apply_patch'
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
