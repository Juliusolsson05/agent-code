import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import type { SubAgentState } from '@preload/api/types.js'
import { SubAgentWatcher } from './SubAgentWatcher'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SubAgentWatcher', () => {
  it('buffers partial JSONL lines and caps retained parsed entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-subagents-'))
    tmpDirs.push(dir)
    const jsonlPath = join(dir, 'agent-child.jsonl')
    const emissions: Record<string, SubAgentState>[] = []
    const watcher = new SubAgentWatcher(
      dir,
      () => ({ done: false, error: false }),
      subAgents => emissions.push(subAgents),
    )

    try {
      await writeFile(
        join(dir, 'agent-child.meta.json'),
        JSON.stringify({
          agentType: 'explorer',
          description: 'Inspect retained transcript behavior.',
          toolUseId: 'tool-parent',
        }),
      )
      await writeFile(jsonlPath, assistantToolUseLine(0).slice(0, -1), 'utf8')

      watcher.start()
      await eventually(() => {
        expect(emissions.at(-1)?.['tool-parent']?.toolCalls).toEqual([])
      })

      await appendFile(jsonlPath, '\n', 'utf8')
      watcher.refresh()
      await eventually(() => {
        expect(emissions.at(-1)?.['tool-parent']?.toolCalls).toHaveLength(1)
      })

      // WHY 520 entries instead of a tiny fixture:
      //
      // The renderer-facing builder already caps the mini-feed to 40 tool
      // calls. To prove the watcher now bounds MAIN-process retained RawEntry
      // memory too, the fixture must exceed the watcher cap (500), not only the
      // renderer cap. Without the watcher cap this would report 481 dropped
      // tool calls (521 total - 40 visible); with the watcher cap it reports
      // 460 (500 retained - 40 visible), proving older parsed entries were
      // discarded before building state.
      await appendFile(
        jsonlPath,
        Array.from({ length: 520 }, (_, i) => assistantToolUseLine(i + 1)).join(''),
        'utf8',
      )
      watcher.refresh()

      await eventually(() => {
        const state = emissions.at(-1)?.['tool-parent']
        expect(state?.toolCalls).toHaveLength(40)
        expect(state?.droppedToolCalls).toBe(460)
        expect(state?.toolCalls.at(-1)).toMatchObject({
          name: 'Read',
          headline: '/tmp/file-520.txt',
          status: 'running',
        })
      })
    } finally {
      watcher.stop()
    }
  })
})

function assistantToolUseLine(i: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tool-${i}`,
          name: 'Read',
          input: { file_path: `/tmp/file-${i}.txt` },
        },
      ],
    },
  })}\n`
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1500
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError
}
