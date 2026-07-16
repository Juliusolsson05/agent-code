import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { WorkflowSourceApprovalStore } from './WorkflowSourceApprovalStore.js'

const request = {
  cwd: '/repo',
  origin: 'root' as const,
  canonicalIdentity: '/repo/.claude/workflows/review.js',
  sourceHash: 'a'.repeat(64),
  workflowName: 'review',
}

describe('WorkflowSourceApprovalStore', () => {
  it('persists approval for exact bytes and prompts again after an edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-source-approval-'))
    const filePath = join(root, 'approvals.json')
    const prompt = vi.fn(async () => true)
    const first = new WorkflowSourceApprovalStore(filePath)

    await expect(Promise.all([
      first.authorize(request, prompt),
      first.authorize(request, prompt),
    ])).resolves.toEqual([true, true])
    expect(prompt).toHaveBeenCalledTimes(1)

    const reopened = new WorkflowSourceApprovalStore(filePath)
    const shouldNotPrompt = vi.fn(async () => false)
    await expect(reopened.authorize(request, shouldNotPrompt)).resolves.toBe(true)
    expect(shouldNotPrompt).not.toHaveBeenCalled()

    await expect(reopened.authorize({ ...request, sourceHash: 'b'.repeat(64) }, shouldNotPrompt))
      .resolves.toBe(false)
    expect(shouldNotPrompt).toHaveBeenCalledOnce()
  })
})
