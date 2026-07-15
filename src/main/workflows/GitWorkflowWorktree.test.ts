import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { prepareGitWorkflowWorktree } from '@main/workflows/GitWorkflowWorktree.js'

const execFileAsync = promisify(execFile)

describe('prepareGitWorkflowWorktree', () => {
  it('reuses the journal-stable workspace across recovery generations', async () => {
    const repository = await createRepository()
    const first = await prepareGitWorkflowWorktree({
      baseDirectory: repository,
      isolation: 'worktree',
      runId: 'run-before-crash',
      agentId: 'agent-before-crash',
      lineageId: 'lineage-1',
      workspaceId: 'workspace-logical-call',
      signal: new AbortController().signal,
    })
    const marker = join(first.path, 'interrupted-agent-marker.txt')
    await writeFile(marker, 'survives restart\n')

    const recovered = await prepareGitWorkflowWorktree({
      baseDirectory: repository,
      isolation: 'worktree',
      runId: 'run-after-crash',
      agentId: 'agent-after-crash',
      lineageId: 'lineage-1',
      workspaceId: 'workspace-logical-call',
      signal: new AbortController().signal,
    })

    expect(recovered.path).toBe(first.path)
    expect(recovered.leaseId).toBe(first.leaseId)
    expect(recovered.reused).toBe(true)
    await expect(readFile(join(recovered.path, 'interrupted-agent-marker.txt'), 'utf8'))
      .resolves.toBe('survives restart\n')

    // A dirty recovered workspace is preserved. Once its output is explicitly reconciled, the
    // original lease cleanup removes the linked worktree and the test repository can be deleted.
    await expect(recovered.cleanup?.({ signal: new AbortController().signal }))
      .resolves.toEqual({ preservedPath: first.path })
    await rm(marker)
    await first.cleanup?.({ signal: new AbortController().signal })
    await rm(repository, { recursive: true, force: true })
  })

  it('passes a pre-aborted signal into Git instead of starting detached preparation', async () => {
    const repository = await createRepository()
    const controller = new AbortController()
    controller.abort(new Error('cancel worktree preparation'))

    await expect(prepareGitWorkflowWorktree({
      baseDirectory: repository,
      isolation: 'worktree',
      runId: 'run-cancelled',
      agentId: 'agent-cancelled',
      lineageId: 'lineage-cancelled',
      workspaceId: 'workspace-cancelled',
      signal: controller.signal,
    })).rejects.toThrow()
    await rm(repository, { recursive: true, force: true })
  })
})

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'agent-code-worktree-test-'))
  await execFileAsync('git', ['init', repository])
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'Agent Code Test'])
  await writeFile(join(repository, 'README.md'), 'fixture\n')
  await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
  await execFileAsync('git', ['-C', repository, 'commit', '-m', 'fixture'])
  return repository
}
