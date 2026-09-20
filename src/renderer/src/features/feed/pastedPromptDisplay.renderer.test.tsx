import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConversationRow } from '@renderer/features/feed/ui/rows/ConversationRow'
import { ProviderContext } from '@renderer/features/feed/context'
import {
  extractLatestUserPrompt,
  extractLatestUserPrompts,
} from '@renderer/features/workspace/lib/latestUserPrompts'
import type { ConversationEntry, Entry } from '@shared/types/transcript'

// ---------------------------------------------------------------------------
// #1059 — Claude's paste envelope must never reach the user.
//
// Claude Code 2.1.278 commits a PASTED prompt wrapped in its own tag:
//
//     <pasted_content id="cade">
//     …what the user actually wrote…
//     </pasted_content id="cade">
//
// #1053 taught prompt ACCEPTANCE about that shape. Nothing taught the surfaces
// that SHOW or REPLAY the prompt, so the owner's transcript read
// `❯ <pasted_content id="cade"> …`, pane titles for any pasted prompt started
// with `<pasted_content id="…`, and ⌘↑ replayed the envelope into the composer
// — which made Claude wrap the already-wrapped text on the next send.
//
// INPUT IS A REAL RECORDING, not a literal shaped to fit: the owner's own
// pasted prompt, lifted verbatim out of
// ~/.claude/projects/…/83a02301-….jsonl. It carries `permissionMode`, which is
// how Agent Code recognises a row the user submitted, and the closing tag
// repeats the id — the detail an invented fixture gets wrong.
//
// These drive the REAL entry points: the exported extractors that pane titles,
// ⌘↑ history, View Prompts and the Rewind picker all call, and the real
// ConversationRow the feed renders.
// ---------------------------------------------------------------------------

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../testing/fixtures/prompt-acceptance/pasted-typed-prompt-2026-09-20.json'),
    'utf8',
  ),
) as { transcriptEntry: ConversationEntry & { permissionMode?: string } }

const RECORDED = FIXTURE.transcriptEntry
const RAW = RECORDED.message.content as unknown as string
/** What the owner actually typed, i.e. everything between the tags. */
const WROTE =
  'Add to the list of things to resolve pre launch that the phone menu is compoletley fucekd up for remote control, it is flashing swithcing positions for the agent index like a million times.'

// Guard the guard: if the recording ever stops being an envelope, every
// assertion below would pass vacuously.
it('the recording really is a wrapped, user-submitted prompt', () => {
  expect(RAW).toContain('<pasted_content id="cade">')
  expect(RAW).toContain('</pasted_content id="cade">')
  expect(RAW).toContain(WROTE)
  expect(RECORDED.permissionMode).toBe('bypassPermissions')
})

describe('pane titles, ⌘↑ history, View Prompts and Rewind (#1059)', () => {
  it('carry the user\'s words, never the envelope', () => {
    const entries: Entry[] = [RECORDED as Entry]

    const latest = extractLatestUserPrompt(entries, 'claude')
    expect(latest?.text).toBe(WROTE)
    expect(latest?.text).not.toContain('pasted_content')

    const history = extractLatestUserPrompts(entries, 'claude')
    expect(history).toHaveLength(1)
    expect(history[0]!.text).toBe(WROTE)
  })

  it('still finds the prompt at all — the envelope must not exclude it', () => {
    // The sibling failure #1053 fixed: `isClaudeTypedUserPrompt` rejects
    // anything starting with `<`, because Claude writes its own markers that
    // way, so a pasted prompt vanished from history entirely. Unwrapping for
    // display must not quietly reintroduce that by unwrapping the wrong thing.
    expect(extractLatestUserPrompts([RECORDED as Entry], 'claude')).not.toEqual([])
  })

  it('collapses two pastes of the same prompt, whose envelope ids differ', () => {
    // Two consecutive pastes of one prompt get DIFFERENT envelope ids, so the
    // consecutive-duplicate guard compared unequal strings and ⌘↑ offered the
    // same prompt twice.
    const second = {
      ...RECORDED,
      uuid: 'second',
      timestamp: '2026-09-20T03:12:00.000Z',
      message: { ...RECORDED.message, content: RAW.replace(/id="cade"/g, 'id="f00d"') },
    }
    const history = extractLatestUserPrompts([RECORDED as Entry, second as unknown as Entry], 'claude')
    expect(history.map(prompt => prompt.text)).toEqual([WROTE])
  })

  it('leaves a non-Claude provider\'s prompt untouched', () => {
    // The envelope is Claude's. A Codex row that happened to contain the same
    // text must not be rewritten by Claude's rule.
    const codexRow = {
      ...RECORDED,
      message: { role: 'user', content: 'plain codex prompt' },
    }
    expect(extractLatestUserPrompt([codexRow as unknown as Entry], 'codex')?.text).toBe('plain codex prompt')
  })
})

describe('the feed row (#1059)', () => {
  function renderRow(entry: ConversationEntry) {
    return render(
      <ProviderContext.Provider value="claude">
        <ConversationRow entry={entry} />
      </ProviderContext.Provider>,
    )
  }

  it('paints the user\'s words for a string message', () => {
    const { container } = renderRow(RECORDED)
    expect(screen.getByText(WROTE)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toContain('pasted_content')
  })

  it('paints the user\'s words for a block-form message', () => {
    // Claude commits some prompts as `[{type:'text'}]` instead of a string
    // (an attachment, a queued send). Fixing only the string form would leave
    // this one painting the envelope.
    const blockForm = {
      ...RECORDED,
      message: { ...RECORDED.message, content: [{ type: 'text', text: RAW }] },
    } as unknown as ConversationEntry
    const { container } = renderRow(blockForm)
    expect(screen.getByText(WROTE)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toContain('pasted_content')
  })

  it('leaves an assistant message alone', () => {
    // Only a USER row is the user's prompt. An assistant message that quotes
    // the envelope — this very test file's subject matter, in a transcript —
    // is the model's output and must render verbatim.
    const assistant = {
      ...RECORDED,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: RAW }] },
    } as unknown as ConversationEntry
    const { container } = renderRow(assistant)
    expect(container.textContent ?? '').toContain('pasted_content')
  })
})
