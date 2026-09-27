import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import fixture from '../../../../testing/fixtures/conversations/codex-0157/typed-prompt-head.json'

import { resolveFamily } from '../family.js'
import { CodexConversationSource } from './codex.js'

// #1363: without a usable index (state_N.sqlite missing or failing schema
// validation, or a rollout the index does not cover) the source reads each
// rollout's head, and it took prompt text ONLY from `event_msg:user_message`.
// Codex 0.157 writes none: a typed prompt is a role-user response_item plus
// `event_msg:item_completed` with `item.type: 'UserMessage'`. Every 0.157
// row came back with no prompt, was classified `empty`, and was hidden from
// the default listing. The input is a REAL 0.157.1 rollout head (see the
// fixture's evidence), with no index beside it, through the real source.

type Record = { type: string; payload?: { type?: string; id?: string; item?: { type?: string; content?: Array<{ type: string; text?: string }> } } }
const records = fixture.records as Record[]
const threadId = records[0]!.payload!.id!
const typedPrompt = records
  .find(record => record.payload?.type === 'item_completed' && record.payload.item?.type === 'UserMessage')!
  .payload!.item!.content!.filter(part => part.type === 'text').map(part => part.text).join('')

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('reads a 0.157 typed prompt from its UserMessage item when there is no index', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-0157-home-'))
  dirs.push(codexHome)
  const day = join(codexHome, 'sessions', '2026', '09', '27')
  await mkdir(day, { recursive: true })
  await writeFile(join(day, `rollout-2026-09-27T03-06-42-${threadId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')

  const source = new CodexConversationSource({ codexHome })
  const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
  const rows = await source.discover({ scope: 'everywhere', family })
  const row = rows.find(candidate => candidate.nativeId === threadId)

  expect(source.lastDowngradeReason()).not.toBeNull()
  expect(row).toBeDefined()
  // Exactly the typed prompt: not the injected AGENTS.md or environment
  // context that precede it as role-user response items.
  expect(row!.userTexts).toEqual([typedPrompt])
  expect(row!.lastUserActivityAt).not.toBeNull()
})

it('lists a rollout carrying both shapes once, from the legacy event', async () => {
  // A file that has `event_msg:user_message` uses it alone, so a rollout
  // written with both carriers never shows its prompt twice.
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-0157-home-'))
  dirs.push(codexHome)
  const day = join(codexHome, 'sessions', '2026', '09', '27')
  await mkdir(day, { recursive: true })
  const legacy = { timestamp: '2026-09-27T10:20:24.186Z', type: 'event_msg', payload: { type: 'user_message', message: typedPrompt } }
  await writeFile(join(day, `rollout-2026-09-27T03-06-42-${threadId}.jsonl`), [...records, legacy].map(record => JSON.stringify(record)).join('\n') + '\n')

  const source = new CodexConversationSource({ codexHome })
  const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
  const row = (await source.discover({ scope: 'everywhere', family })).find(candidate => candidate.nativeId === threadId)
  expect(row!.userTexts).toEqual([typedPrompt])
})
