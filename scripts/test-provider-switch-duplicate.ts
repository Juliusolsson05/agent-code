import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'

import { duplicateSession } from '../src/main/providerSwitch/duplicateSession'
import { switchProvider } from '../src/main/providerSwitch/switchProvider'
import { getProjectDirForCwd } from '../src/shared/runtime/projectDir'
import { getCodexSessionsDir } from '../src/providers/codex/runtime/projectDir'

const root = await mkdtemp(join(tmpdir(), 'agent-code-provider-switch-'))
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousCodexHome = process.env.CODEX_HOME
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.CODEX_HOME = join(root, 'codex')

try {
  const sourceCwd = join(root, 'source-project')
  const targetCwd = join(root, 'target-project')
  const sourceSessionId = '11111111-1111-4111-8111-111111111111'
  const unresolvedToolUseId = 'toolu_unresolved'
  const resolvedToolUseId = 'toolu_resolved'
  const sourceEntries: ClaudeEntry[] = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: sourceSessionId,
      timestamp: '2026-05-19T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Run something.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: sourceSessionId,
      timestamp: '2026-05-19T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run a completed tool.' },
          { type: 'tool_use', id: resolvedToolUseId, name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: unresolvedToolUseId, name: 'Bash', input: { command: 'sleep 1' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId: sourceSessionId,
      timestamp: '2026-05-19T10:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: resolvedToolUseId, content: 'ok' },
        ],
      },
    },
  ]

  const sourceProjectDir = await getProjectDirForCwd(sourceCwd)
  const targetProjectDir = await getProjectDirForCwd(targetCwd)
  await mkdir(sourceProjectDir, { recursive: true })
  await writeFile(
    join(sourceProjectDir, `${sourceSessionId}.jsonl`),
    `${sourceEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  )

  const duplicate = await duplicateSession({
    provider: 'claude',
    sourceProviderSessionId: sourceSessionId,
    cwd: targetCwd,
    sourceCwd,
    targetCwd,
  })

  assert.equal(duplicate.newFilePath.startsWith(targetProjectDir), true)
  assert.equal(duplicate.newFilePath.startsWith(sourceProjectDir), false)

  const clonedText = await readFile(duplicate.newFilePath, 'utf8')
  assert.equal(clonedText.includes(unresolvedToolUseId), false)
  assert.equal(clonedText.includes(resolvedToolUseId), true)
  assert.equal(clonedText.includes(duplicate.newProviderSessionId), true)

  const switched = await switchProvider({
    sourceKind: 'claude',
    sourceProviderSessionId: sourceSessionId,
    cwd: targetCwd,
    sourceCwd,
    targetCwd,
  })
  const switchedText = await readFile(switched.targetFilePath, 'utf8')
  assert.equal(switchedText.includes(unresolvedToolUseId), false)
  assert.equal(switchedText.includes(resolvedToolUseId), true)

  const codexSourceId = '22222222-2222-4222-8222-222222222222'
  const unresolvedCallId = 'call_unresolved'
  const resolvedCallId = 'call_resolved'
  const codexLines: CodexRolloutLine[] = [
    {
      timestamp: '2026-05-19T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: codexSourceId, timestamp: '2026-05-19T10:00:00.000Z', cwd: sourceCwd },
    },
    {
      timestamp: '2026-05-19T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'done', arguments: '{}', call_id: resolvedCallId },
    },
    {
      timestamp: '2026-05-19T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: resolvedCallId, output: 'ok' },
    },
    {
      timestamp: '2026-05-19T10:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'dangling', arguments: '{}', call_id: unresolvedCallId },
    },
  ]
  const codexDir = join(getCodexSessionsDir(), '2026', '05', '19')
  await mkdir(codexDir, { recursive: true })
  const codexSourcePath = join(
    codexDir,
    `rollout-2026-05-19T10-00-00-${codexSourceId}.jsonl`,
  )
  await writeFile(
    codexSourcePath,
    `${codexLines.map(line => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )

  const codexDuplicate = await duplicateSession({
    provider: 'codex',
    sourceProviderSessionId: codexSourceId,
    cwd: targetCwd,
  })
  const codexDuplicateText = await readFile(codexDuplicate.newFilePath, 'utf8')
  assert.equal(codexDuplicateText.includes(unresolvedCallId), false)
  assert.equal(codexDuplicateText.includes(resolvedCallId), true)
} finally {
  if (previousClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
  }
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = previousCodexHome
  }
  await rm(root, { recursive: true, force: true })
}
