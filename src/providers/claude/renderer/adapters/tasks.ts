import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type ClaudeTaskActivityModel =
  | {
      kind: 'create'
      operationId: string
      label: 'Create task'
      subject: string
      description: string
      activeForm: string
      input: Record<string, unknown>
    }
  | {
      kind: 'update'
      operationId: string
      label: 'Update task'
      subject: string
      taskId: string
      status: 'pending' | 'in_progress' | 'completed' | 'deleted'
      input: Record<string, unknown>
    }
  | {
      kind: 'skill'
      operationId: string
      label: 'Skill'
      subject: string
      input: Record<string, unknown>
    }
  | {
      kind: 'schedule'
      operationId: string
      label: 'Schedule wakeup'
      subject: string
      delaySeconds: number
      reason: string
      prompt: string
      input: Record<string, unknown>
    }

export type ClaudeTaskActivityResult = {
  text: string
}

const MAX_SUBJECT_CHARS = 400
const MAX_DESCRIPTION_CHARS = 2_000
const MAX_ACTIVE_FORM_CHARS = 400
const MAX_REASON_CHARS = 1_000

function boundScalar(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && /\S/.test(value) ? value : null
}

function delayLabel(seconds: number): string {
  if (seconds < 60) return `in ${seconds}s`
  if (seconds % 3_600 === 0) return `in ${seconds / 3_600}h`
  if (seconds % 60 === 0) return `in ${seconds / 60}m`
  return `in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function fromClaudeTaskActivityUse(block: ToolUseBlock): ClaudeTaskActivityModel | null {
  const input = asRecord(block.input)
  if (!input || !/\S/.test(block.id)) return null

  if (block.name === 'TaskCreate') {
    const subject = nonEmptyString(input.subject)
    const description = nonEmptyString(input.description)
    const activeForm = nonEmptyString(input.activeForm)
    if (!subject || !description || !activeForm) return null
    return {
      kind: 'create',
      operationId: block.id,
      label: 'Create task',
      subject: boundScalar(subject, MAX_SUBJECT_CHARS),
      description: boundScalar(description, MAX_DESCRIPTION_CHARS),
      activeForm: boundScalar(activeForm, MAX_ACTIVE_FORM_CHARS),
      input,
    }
  }

  if (block.name === 'TaskUpdate') {
    const taskId = nonEmptyString(input.taskId)
    const status = input.status
    if (
      !taskId ||
      (status !== 'pending' &&
        status !== 'in_progress' &&
        status !== 'completed' &&
        status !== 'deleted')
    ) return null
    return {
      kind: 'update',
      operationId: block.id,
      label: 'Update task',
      subject: `Task #${taskId}`,
      taskId,
      status,
      input,
    }
  }

  if (block.name === 'Skill') {
    const skill = nonEmptyString(input.skill)
    if (!skill) return null
    return {
      kind: 'skill',
      operationId: block.id,
      label: 'Skill',
      subject: boundScalar(skill, MAX_SUBJECT_CHARS),
      input,
    }
  }

  if (block.name === 'ScheduleWakeup') {
    const delaySeconds = input.delaySeconds
    const reason = nonEmptyString(input.reason)
    const prompt = nonEmptyString(input.prompt)
    if (
      typeof delaySeconds !== 'number' ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 0 ||
      !reason ||
      !prompt
    ) return null
    return {
      kind: 'schedule',
      operationId: block.id,
      label: 'Schedule wakeup',
      subject: delayLabel(delaySeconds),
      delaySeconds,
      reason: boundScalar(reason, MAX_REASON_CHARS),
      // WHY prompt stays exact while the headline scalars are capped: the
      // task row sends prompt through PagedTextViewer, which bounds each DOM
      // page without discarding later evidence. Truncating here would make the
      // wake instruction impossible to inspect in full.
      prompt,
      input,
    }
  }

  return null
}

function resultText(result: ToolResultBlock): string | null {
  if (typeof result.content === 'string') return result.content
  if (!Array.isArray(result.content) || result.content.length !== 1) return null
  const item = asRecord(result.content[0])
  return item?.type === 'text' && typeof item.text === 'string' ? item.text : null
}

export function fromClaudeTaskActivityResult(
  result: ToolResultBlock,
  model: ClaudeTaskActivityModel,
): ClaudeTaskActivityResult | null {
  if (result.tool_use_id !== model.operationId || result.is_error === true) return null
  const text = resultText(result)
  if (!text) return null

  const valid = model.kind === 'create'
    ? /^Task #\S+ created successfully: .+$/s.test(text)
    : model.kind === 'update'
      ? /^Updated task #\S+ status$/s.test(text)
      : model.kind === 'skill'
        ? /^Launching skill: .+$/s.test(text)
        : /^Next wakeup scheduled for .+$/s.test(text)
  return valid ? { text } : null
}
