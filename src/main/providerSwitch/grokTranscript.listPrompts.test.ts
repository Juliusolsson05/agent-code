import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeGrokSessionsDir } from 'grok-code-headless'

import { getHostTranscriptAdapter } from './transcriptEngine.js'

// Rewind prompt references must come from the DECODED document (review
// finding 1): row-level classifiers also admit the untagged <user_info>
// bootstrap row, which the parser decodes opaque — and resolving that line
// threw PromptAddressNotFoundError on 20 of 26 recorded sessions. This test
// builds the real session-directory layout with the corpus row shapes and
// asserts every listed prompt RESOLVES and says what the user typed.

const rows = [
  { type: 'system', content: 'instructions' },
  { type: 'user', content: [{ type: 'text', text: '<user_info>\nworkspace preamble\n</user_info>' }] },
  { type: 'user', content: [{ type: 'text', text: '<user_query>\nfirst real prompt\n</user_query>' }], prompt_index: 0 },
  { type: 'assistant', content: 'first answer' },
  { type: 'user', content: [{ type: 'text', text: '<user_query>\nsecond prompt\n</user_query>' }], prompt_index: 1 },
  { type: 'assistant', content: 'second answer' },
]

let home: string
let cwd: string

describe('grok adapter listPrompts over the real session layout', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'grok-listprompts-'))
    cwd = join(home, 'workspace')
    await mkdir(cwd, { recursive: true })
    vi.stubEnv('GROK_HOME', home)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('lists exactly the decoded user messages, resolvable and unwrapped', async () => {
    const sessionId = randomUUID()
    const directory = join(home, 'sessions', encodeGrokSessionsDir(cwd), sessionId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'chat_history.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    await writeFile(join(directory, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd }, chat_format_version: 1,
      num_chat_messages: rows.length, num_messages: 0, created_at: '2026-09-19T00:00:00Z',
    }) + '\n')

    const adapter = getHostTranscriptAdapter('grok')
    const prompts = await adapter.listPrompts(cwd, sessionId)
    // Newest first per the engine contract, unwrapped, preamble absent. The
    // FIRST prompt is absent by the provider-neutral resumable-prefix rule
    // (rewinding it would leave no history); its only preceding rows are the
    // opaque system and bootstrap entries, which do not count as a prefix.
    expect(prompts.map(prompt => prompt.text)).toEqual(['second prompt'])
    // The guards the review moved into the loader: a format bump refuses.
    await writeFile(join(directory, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd }, chat_format_version: 2,
      num_chat_messages: rows.length, num_messages: 0,
    }) + '\n')
    await expect(adapter.read(cwd, sessionId)).rejects.toThrow(/Unsupported Grok chat format/)
  })
})
