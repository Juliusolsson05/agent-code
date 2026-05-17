import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AiWorkspaceRegistry } from '../src/main/aiWorkspace/AiWorkspaceRegistry'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-'))
  try {
    const stateFile = join(dir, 'ai-workspaces.json')
    const file = join(dir, 'plan.md')
    await writeFile(file, '# Plan\n', 'utf8')

    const registry = new AiWorkspaceRegistry(stateFile)
    const workspace = await registry.create({
      name: 'Issue planning review',
      scope: { issueId: '157' },
    })
    assert(workspace.workspaceId, 'workspace id should be stable')

    const duplicate = await registry.create({
      name: 'Issue planning review',
      scope: { issueId: '157' },
    })
    assert(duplicate.workspaceId === workspace.workspaceId, 'create should be idempotent by name + scope')

    const entry = await registry.attachFile({
      workspaceId: workspace.workspaceId,
      path: file,
      title: 'Worker plan',
      taskId: '157',
    })
    assert(entry.title === 'Worker plan', 'attached entry should preserve title')
    assert(entry.status.exists && entry.status.readable, 'attached file should be readable')

    const listed = await registry.list()
    assert(listed.length === 1, 'list should contain one workspace')
    assert(listed[0].fileCount === 1, 'summary should count attached files')

    const read = await registry.readFile(file)
    assert(read.ok && read.text.includes('# Plan'), 'readFile should read attached path')

    const write = await registry.writeFile({
      path: file,
      text: '# Updated\n',
      expectedMtimeMs: read.ok ? read.mtimeMs : null,
    })
    assert(write.ok, 'writeFile should update attached path')
    assert((await readFile(file, 'utf8')) === '# Updated\n', 'writeFile should persist text')

    const detached = await registry.detachFile({
      workspaceId: workspace.workspaceId,
      entryId: entry.entryId,
    })
    assert(detached.removed && detached.remaining === 0, 'detach should remove entry')

    await registry.attachFile({ workspaceId: workspace.workspaceId, path: file })
    const cleared = await registry.clear(workspace.workspaceId)
    assert(cleared.removed === 1, 'clear should remove all entries')

    const deleted = await registry.delete(workspace.workspaceId)
    assert(deleted.deleted, 'delete should remove workspace record')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await main()
