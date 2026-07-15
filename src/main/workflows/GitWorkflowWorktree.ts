import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { WorkingDirectoryPreparer } from 'workflow-mcp'

const execFileAsync = promisify(execFile)

/** Prepare the fresh detached worktree requested by Claude's `isolation: 'worktree'` option. */
export const prepareGitWorkflowWorktree: WorkingDirectoryPreparer = async input => {
  if (input.isolation !== 'worktree') {
    throw new Error(`Unsupported workflow isolation ${JSON.stringify(input.isolation)}`)
  }

  const { stdout } = await execFileAsync('git', [
    '-C', input.baseDirectory, 'rev-parse', '--show-toplevel',
  ], { encoding: 'utf8' })
  const repository = stdout.trim()
  if (!repository) throw new Error(`Cannot resolve Git repository from ${input.baseDirectory}`)

  const parent = await mkdtemp(join(tmpdir(), 'agent-code-workflow-'))
  const worktree = join(parent, `${safeSegment(input.runId)}-${safeSegment(input.agentId)}`)
  try {
    await execFileAsync('git', [
      '-C', repository, 'worktree', 'add', '--detach', worktree, 'HEAD',
    ], { encoding: 'utf8' })
  } catch (error) {
    await rm(parent, { recursive: true, force: true })
    throw error
  }

  return {
    path: worktree,
    async cleanup() {
      const status = await execFileAsync('git', [
        '-C', worktree, 'status', '--porcelain', '--untracked-files=all',
      ], { encoding: 'utf8' })
      if (status.stdout.trim().length > 0) {
        // WHY changed worktrees survive: the isolated agent's edits are its output. Force-removing
        // them would make successful mutation workflows appear to complete while discarding all
        // work. runWorkflow turns this result into a durable warning containing the exact path.
        return { preservedPath: worktree }
      }
      await execFileAsync('git', [
        '-C', repository, 'worktree', 'remove', '--force', worktree,
      ], { encoding: 'utf8' })
      await rm(parent, { recursive: true, force: true })
    },
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
}
