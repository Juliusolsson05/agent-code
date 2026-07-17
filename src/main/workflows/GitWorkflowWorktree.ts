import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, rmdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { WorkingDirectoryPreparer } from 'workflow-mcp'

const execFileAsync = promisify(execFile)

const WORKTREE_ROOT = join(tmpdir(), 'agent-code-workflow-worktrees')

/** Prepare the durable detached worktree requested by Claude's `isolation: 'worktree'` option. */
export const prepareGitWorkflowWorktree: WorkingDirectoryPreparer = async input => {
  if (input.isolation !== 'worktree') {
    throw new Error(`Unsupported workflow isolation ${JSON.stringify(input.isolation)}`)
  }

  const { stdout } = await execFileAsync('git', [
    '-C', input.baseDirectory, 'rev-parse', '--show-toplevel',
  ], { encoding: 'utf8', signal: input.signal })
  const repository = stdout.trim()
  if (!repository) throw new Error(`Cannot resolve Git repository from ${input.baseDirectory}`)

  // WHY paths are keyed by recovery lineage and the runtime's journal-derived workspace ID:
  // runId/agentId change when a crashed generation is resumed, but the logical call and its edits
  // do not. A random mkdtemp path silently gave every recovery a blank checkout and orphaned the
  // interrupted agent's work. The repository digest prevents unrelated checkouts from sharing a
  // namespace without exposing a long user path in /tmp.
  const repositoryKey = createHash('sha256').update(repository).digest('hex').slice(0, 20)
  const lineageDirectory = join(WORKTREE_ROOT, repositoryKey, safeSegment(input.lineageId))
  const worktree = join(lineageDirectory, safeSegment(input.workspaceId))
  await mkdir(lineageDirectory, { recursive: true, mode: 0o700 })

  let reused = false
  if (await exists(worktree)) {
    const expectedCommonDirectory = await gitCommonDirectory(repository, input.signal)
    const actualCommonDirectory = await gitCommonDirectory(worktree, input.signal).catch(() => undefined)
    if (actualCommonDirectory !== expectedCommonDirectory) {
      // Never delete an unexpected directory at a deterministic recovery path. Preserving it and
      // stopping the run is safer than destroying evidence or another checkout after corruption.
      throw new Error(`Workflow workspace path exists but is not linked to ${repository}: ${worktree}`)
    }
    reused = true
  } else {
    await execFileAsync('git', [
      '-C', repository, 'worktree', 'add', '--detach', worktree, 'HEAD',
    ], { encoding: 'utf8', signal: input.signal })
  }

  return {
    path: worktree,
    leaseId: `${safeSegment(input.lineageId)}:${safeSegment(input.workspaceId)}`,
    reused,
    async cleanup(cleanupInput) {
      const signal = cleanupInput?.signal ?? new AbortController().signal
      const status = await execFileAsync('git', [
        '-C', worktree, 'status', '--porcelain', '--untracked-files=all',
      ], { encoding: 'utf8', signal })
      if (status.stdout.trim().length > 0) {
        // WHY changed worktrees survive: the isolated agent's edits are its output. Force-removing
        // them would make successful mutation workflows appear to complete while discarding all
        // work. runWorkflow turns this result into a durable warning containing the exact path.
        return { preservedPath: worktree }
      }
      await execFileAsync('git', [
        '-C', repository, 'worktree', 'remove', '--force', worktree,
      ], { encoding: 'utf8', signal })
      await rm(worktree, { recursive: true, force: true })
      // These removals are intentionally non-recursive. Another logical call or lineage may still
      // own a sibling, and cleanup must never turn one lease into a namespace-wide delete.
      await rmdir(lineageDirectory).catch(() => undefined)
      await rmdir(join(WORKTREE_ROOT, repositoryKey)).catch(() => undefined)
    },
  }
}

async function gitCommonDirectory(directory: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C', directory, 'rev-parse', '--git-common-dir',
  ], { encoding: 'utf8', signal })
  const common = stdout.trim()
  if (!common) throw new Error(`Cannot resolve Git common directory from ${directory}`)
  return resolve(directory, common)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
}
