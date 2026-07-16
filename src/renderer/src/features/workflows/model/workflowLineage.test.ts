import { describe, expect, it } from 'vitest'
import { createWorkflowState } from 'workflow-mcp/state'
import type { WorkflowState } from 'workflow-mcp/state'

import { mergeWorkflowLineage } from './workflowLineage'

describe('mergeWorkflowLineage', () => {
  it('uses finite shared counts for a recovery-required logical agent', () => {
    const current: WorkflowState = {
      ...createWorkflowState('current'),
      agents: [{
        id: 'agent-1',
        callIndex: 0,
        label: 'ambiguous mutation',
        prompt: { preview: 'inspect', lineCount: 1, content: 'inspect' },
        options: {},
        cacheKey: 'same-logical-agent',
        status: 'recovery_required',
        admittedAt: '2026-07-16T00:00:00.000Z',
        attempts: [],
      }],
    }

    const merged = mergeWorkflowLineage([createWorkflowState('previous')], current)

    expect(merged.counts.recovery_required).toBe(1)
    expect(Number.isFinite(merged.counts.recovery_required)).toBe(true)
    expect(merged.counts.total).toBe(1)
  })
})
