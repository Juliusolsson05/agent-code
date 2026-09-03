import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { JsonlEntry, SubAgentState } from '@preload/api/types.js'
import { SubAgentWatcherManager } from './index.js'

// #743 end to end: a parent tool_result recorded BEFORE the sidecar is
// discovered still flips the sub-agent to done once the watcher claims it,
// and thousands of unrelated results afterwards do not unclaim it.

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function toolResultEntry(toolUseId: string, index: number): JsonlEntry {
  return {
    type: 'user',
    uuid: `u-${index}`,
    parentUuid: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  } as unknown as JsonlEntry
}

async function eventually(assert: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assert()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => { setTimeout(resolve, 25) })
    }
  }
}

describe('SubAgentWatcherManager parent completion', () => {
  it('claims a result recorded before the sidecar existed and keeps it through unrelated results', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'agent-code-subagent-mgr-'))
    tmpDirs.push(projectDir)
    const transcript = join(projectDir, 'session-1.jsonl')
    const subagentsDir = join(projectDir, 'session-1', 'subagents')
    const emissions: Record<string, SubAgentState>[] = []
    const manager = new SubAgentWatcherManager((_sessionId, subAgents) => emissions.push(subAgents))

    try {
      // The parent records the sub-agent's result first; no sidecar yet.
      manager.observeParentEntry('local-1', toolResultEntry('tool-agent', 0), transcript)

      await mkdir(subagentsDir, { recursive: true })
      await writeFile(
        join(subagentsDir, 'agent-child.meta.json'),
        JSON.stringify({ agentType: 'explorer', description: 'child', toolUseId: 'tool-agent' }),
      )
      await writeFile(join(subagentsDir, 'agent-child.jsonl'), '')

      await eventually(() => {
        expect(emissions.at(-1)?.['tool-agent']?.status).toBe('done')
      })

      // Far more unrelated results than the recent window holds.
      for (let i = 1; i <= 3_000; i += 1) {
        manager.observeParentEntry('local-1', toolResultEntry(`tool-other-${i}`, i), transcript)
      }
      await eventually(() => {
        expect(emissions.at(-1)?.['tool-agent']?.status).toBe('done')
      })
      expect(emissions.length).toBeGreaterThan(0)
    } finally {
      manager.stopAll()
    }
  })
})
