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
// Codex 0.157 writes none: a prompt is `event_msg:item_completed` with
// `item.type: 'UserMessage'`. Every 0.157 row came back with no prompt, was
// classified `empty`, and was hidden from the default listing.
//
// The fixture is a REAL, CONTIGUOUS 0.157.0 rollout head (see its evidence),
// with its expected first prompt recorded independently of the parser under
// test. The later cases compose synthetic records AROUND that real head, and
// say so.

type Rec = Record<string, unknown>
const records = fixture.records as Rec[]
const threadId = (records[0]!.payload as { id: string }).id
const expected = fixture.expected
const at = (offsetMs: number) => new Date(Date.parse(expected.firstPromptTimestamp) + offsetMs).toISOString()
const userMessage = (timestamp: string, content: Array<Record<string, unknown>>): Rec => ({
  timestamp, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: `u-${timestamp}`, content } },
})
const legacyMessage = (timestamp: string, message: string): Rec => ({ timestamp, type: 'event_msg', payload: { type: 'user_message', message } })
const text = (value: string) => ({ type: 'text', text: value, text_elements: [] })

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function discoverRow(lines: Rec[]) {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-0157-home-'))
  dirs.push(codexHome)
  const day = join(codexHome, 'sessions', '2026', '09', '24')
  await mkdir(day, { recursive: true })
  await writeFile(join(day, `rollout-2026-09-24T22-40-13-${threadId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  const source = new CodexConversationSource({ codexHome })
  const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
  const rows = await source.discover({ scope: 'everywhere', family })
  expect(source.lastDowngradeReason()).not.toBeNull()
  return rows.find(candidate => candidate.nativeId === threadId)!
}

it('reads a 0.157 prompt from its UserMessage item when there is no index', async () => {
  const row = await discoverRow(records)
  // Exactly the prompt: not the injected AGENTS.md or environment context
  // that precede it as role-user response items in the real head.
  expect(row.userTexts).toEqual(['x'.repeat(expected.firstPromptLength)])
  expect(row.lastUserActivityAt).toBe(Date.parse(expected.firstPromptTimestamp))
})

it('keeps both carriers\' prompts, counting a prompt written by both once', async () => {
  // A session resumed across writer versions (#1407 reviews a and b): the
  // legacy event and the item for prompt A, then an item for prompt B only.
  const row = await discoverRow([
    ...records,
    legacyMessage(at(1000), 'prompt A'),
    userMessage(at(1001), [text('prompt A')]),
    userMessage(at(2000), [text('prompt B')]),
  ])
  expect(row.userTexts).toEqual(['x'.repeat(expected.firstPromptLength), 'prompt A', 'prompt B'])
  expect(row.lastUserActivityAt).toBe(Date.parse(at(2000)))
})

it('joins text parts with no separator and labels an image-only prompt', async () => {
  // Codex's UserMessageItem::message() joins parts with no separator, and its
  // preview text for an image-only message is `[Image]`.
  const row = await discoverRow([
    ...records,
    userMessage(at(1000), [text('two '), text('parts')]),
    userMessage(at(2000), [{ type: 'image', image_url: 'data:image/png;base64,AAAA' }]),
  ])
  expect(row.userTexts.slice(1)).toEqual(['two parts', '[Image]'])
})

it('takes user activity from the tail when the head bound hides a later prompt', async () => {
  // 33 of 61 local 0.157.0 files have a prompt past the 200-record head; one
  // came 46.8 hours after the first. The listing sorts by this time.
  const filler = Array.from({ length: 300 }, (_, i) => ({ timestamp: at(10 + i), type: 'event_msg', payload: { type: 'token_count', info: null } }))
  const later = at(46.8 * 3600 * 1000)
  const row = await discoverRow([...records, ...filler, userMessage(later, [text('much later prompt')])])
  expect(row.userTexts).toEqual(['x'.repeat(expected.firstPromptLength)])
  expect(row.lastUserActivityAt).toBe(Date.parse(later))
})

it('finds the newest prompt far behind a long agent turn', async () => {
  // #1407 verification a: in 10 local 0.157 files the latest prompt lay
  // wholly before a fixed 512 KiB tail. Here 4 MiB of agent output follow it.
  const later = at(46.6 * 3600 * 1000)
  const bulk = 'y'.repeat(64 * 1024)
  const filler = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ timestamp: at(from + i), type: 'response_item', payload: { type: 'reasoning', summary: [], content: bulk } }))
  const row = await discoverRow([...records, ...filler(250, 10), userMessage(later, [text('much later prompt')]), ...filler(64, 46.6 * 3600 * 1000 + 1)])
  expect(row.lastUserActivityAt).toBe(Date.parse(later))
})

it('finds the newest prompt when its line straddles a read-chunk boundary', async () => {
  // #1407 verification a: the tail reader dropped a record that started
  // before its window. Lay the file out so the prompt's line ends exactly half
  // inside the last 512 KiB chunk: bytes after the line = 512 KiB - half.
  const later = at(46.6 * 3600 * 1000)
  const bulk = 'y'.repeat(64 * 1024)
  const head = [...records, ...Array.from({ length: 250 }, (_, i) => ({ timestamp: at(10 + i), type: 'response_item', payload: { type: 'reasoning', summary: [], content: bulk } }))]
  const prompt = userMessage(later, [text('much later prompt')])
  const promptLine = JSON.stringify(prompt)
  const bytesAfter = 512 * 1024 - Math.floor(promptLine.length / 2)
  // After the prompt line: '\n' + tailLine + '\n' (discoverRow's join and final newline).
  const base = { timestamp: at(46.6 * 3600 * 1000 + 1), type: 'response_item', payload: { type: 'reasoning', summary: [], content: '' } }
  const pad = bytesAfter - 2 - JSON.stringify(base).length
  const tail = { ...base, payload: { ...base.payload, content: 'y'.repeat(pad) } }
  expect(Buffer.byteLength(JSON.stringify(tail)) + 2).toBe(bytesAfter)
  const row = await discoverRow([...head, prompt, tail])
  expect(row.lastUserActivityAt).toBe(Date.parse(later))
})

it('keeps a prompt the user really repeated in a later turn', async () => {
  // #1407 verification a: identical text in a LATER turn is a new prompt, not
  // the other carrier of an earlier one. Only a nearby pair is one prompt.
  const row = await discoverRow([
    ...records,
    legacyMessage(at(1000), 'repeat'),
    legacyMessage(at(2000), 'different'),
    ...Array.from({ length: 10 }, (_, i) => ({ timestamp: at(3000 + i), type: 'event_msg', payload: { type: 'token_count', info: null } })),
    userMessage(at(48 * 3600 * 1000), [text('repeat')]),
  ])
  expect(row.userTexts.slice(1)).toEqual(['repeat', 'different', 'repeat'])
})

it('keeps a later repeat even when it is only two records on', async () => {
  // #1407 verification a, round 2: the exact reported sequence, with no
  // records between. The pair window is records AND time.
  const row = await discoverRow([
    ...records,
    legacyMessage(at(1000), 'repeat'),
    legacyMessage(at(2000), 'different'),
    userMessage(at(48 * 3600 * 1000), [text('repeat')]),
  ])
  expect(row.userTexts.slice(1)).toEqual(['repeat', 'different', 'repeat'])
})

it('finds a newest prompt whose single line is longer than two read chunks', async () => {
  // #1407 verification a, round 2: a window with no newline is all one line.
  const later = at(46.6 * 3600 * 1000)
  const bulk = 'y'.repeat(64 * 1024)
  const head = [...records, ...Array.from({ length: 250 }, (_, i) => ({ timestamp: at(10 + i), type: 'response_item', payload: { type: 'reasoning', summary: [], content: bulk } }))]
  const huge = userMessage(later, [text('z'.repeat(1_200_000))])
  const row = await discoverRow([...head, huge])
  expect(row.lastUserActivityAt).toBe(Date.parse(later))
})
