import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

  it('honours valid approvals beside an unreadable entry and never approves or drops that entry (#1251 row 11)', async () => {
    // One bad entry used to throw from load() on every authorize(), so every
    // repository workflow failed until the user hand-edited the file.
    const root = await mkdtemp(join(tmpdir(), 'workflow-source-approval-'))
    const filePath = join(root, 'approvals.json')
    const unreadable = { canonicalIdentity: '/repo/.claude/workflows/other.js', sourceHash: 'not-a-sha', approvedAt: '2026-09-01T00:00:00.000Z' }
    await writeFile(filePath, JSON.stringify({
      version: 1,
      approvals: [
        { canonicalIdentity: request.canonicalIdentity, sourceHash: request.sourceHash, approvedAt: '2026-09-01T00:00:00.000Z' },
        unreadable,
      ],
    }))
    const store = new WorkflowSourceApprovalStore(filePath)
    const shouldNotPrompt = vi.fn(async () => false)
    await expect(store.authorize(request, shouldNotPrompt)).resolves.toBe(true)
    expect(shouldNotPrompt).not.toHaveBeenCalled()

    // The unreadable entry grants nothing: its source still needs a prompt.
    const approve = vi.fn(async () => true)
    const other = { ...request, canonicalIdentity: unreadable.canonicalIdentity, sourceHash: 'c'.repeat(64) }
    await expect(store.authorize(other, approve)).resolves.toBe(true)
    expect(approve).toHaveBeenCalledOnce()

    // Persisting the new grant keeps the entry this build could not read.
    const written = JSON.parse(await readFile(filePath, 'utf8')) as { approvals: unknown[] }
    expect(written.approvals).toContainEqual(unreadable)
    expect(written.approvals).toHaveLength(3)
  })
})
