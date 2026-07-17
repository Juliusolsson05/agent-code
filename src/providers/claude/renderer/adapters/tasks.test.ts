import { describe, expect, it } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import {
  fromClaudeTaskActivityResult,
  fromClaudeTaskActivityUse,
} from './tasks'

describe('Claude task activity adapter', () => {
  it('parses the four evidence-backed task families', () => {
    const cases: Array<[ToolUseBlock, string, string]> = [
      [{
        type: 'tool_use', id: 'create', name: 'TaskCreate', input: {
          subject: 'Audit renderer', description: 'Read every route', activeForm: 'Auditing renderer',
        },
      }, 'create', 'Audit renderer'],
      [{
        type: 'tool_use', id: 'update', name: 'TaskUpdate', input: {
          taskId: '7', status: 'in_progress',
        },
      }, 'update', 'Task #7'],
      [{
        type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'superpowers:writing-plans' },
      }, 'skill', 'superpowers:writing-plans'],
      [{
        type: 'tool_use', id: 'wake', name: 'ScheduleWakeup', input: {
          delaySeconds: 600, reason: 'Auditors are running', prompt: 'Continue the implementation',
        },
      }, 'schedule', 'in 10m'],
    ]

    for (const [block, kind, subject] of cases) {
      expect(fromClaudeTaskActivityUse(block)).toMatchObject({ kind, subject })
    }
  })

  it('declines incomplete prefixes and unknown statuses', () => {
    expect(fromClaudeTaskActivityUse({
      type: 'tool_use', id: 'partial', name: 'TaskCreate', input: { subject: 'Only a prefix' },
    })).toBeNull()
    expect(fromClaudeTaskActivityUse({
      type: 'tool_use', id: 'drift', name: 'TaskUpdate', input: { taskId: '1', status: 'paused' },
    })).toBeNull()
  })

  it('absorbs only the observed result acknowledgement', () => {
    const model = fromClaudeTaskActivityUse({
      type: 'tool_use', id: 'create', name: 'TaskCreate', input: {
        subject: 'Audit renderer', description: 'Read routes', activeForm: 'Auditing',
      },
    })!
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'create',
      content: 'Task #1 created successfully: Audit renderer',
    }
    expect(fromClaudeTaskActivityResult(result, model)?.text).toContain('created successfully')
    expect(fromClaudeTaskActivityResult({ ...result, content: 'maybe created' }, model)).toBeNull()
  })
})
