import { describe, expect, it } from 'vitest'

import type { ReaderMessage } from './readerMessages'
import { nextReaderSelection } from './readerSelection'

const msg = (id: string, text: string, sourceId: string | null = null, live = false): ReaderMessage => ({
  id,
  text,
  live,
  sourceId,
})

describe('nextReaderSelection', () => {
  it('starts on the newest message', () => {
    expect(nextReaderSelection([], null, [msg('a', 'one'), msg('b', 'two')], false))
      .toEqual({ id: 'b', moved: true })
  })

  it('clears the selection when there is nothing to read', () => {
    expect(nextReaderSelection([msg('a', 'one')], 'a', [], true)).toEqual({ id: null, moved: true })
    expect(nextReaderSelection([], null, [], true)).toEqual({ id: null, moved: false })
  })

  it('stays put, unmoved, while the selected message grows in place', () => {
    const before = [msg('a', 'one'), msg('live', 'Stream', 'm2', true)]
    const after = [msg('a', 'one'), msg('live', 'Streaming on', 'm2', true)]
    expect(nextReaderSelection(before, 'live', after, true)).toEqual({ id: 'live', moved: false })
  })

  describe('following (the reader is pinned to the growing end)', () => {
    it('moves onto a genuinely new page', () => {
      const before = [msg('a', 'one'), msg('b0', 'First block', 'm', true)]
      const after = [msg('a', 'one'), msg('b0', 'First block', 'm'), msg('b2', 'Second', 'm', true)]
      expect(nextReaderSelection(before, 'b0', after, true)).toEqual({ id: 'b2', moved: true })
    })

    it('counts a new page as a move even when it repeats the previous text', () => {
      // Text continuation is not identity: the old page is still in the list,
      // so this is a different page and must start from the top.
      const before = [msg('a', 'one'), msg('b', 'Answer', 'm1')]
      const after = [msg('a', 'one'), msg('b', 'Answer', 'm1'), msg('c', 'Answer, and more', 'm2', true)]
      expect(nextReaderSelection(before, 'b', after, true)).toEqual({ id: 'c', moved: true })
    })

    it('does not treat an earlier block committing below the live block as a new page', () => {
      // The ledger stamps every block of the current turn with the turn's start
      // time and a committed JSONL line with its own (later) time, so block 0's
      // entry can sort AFTER the still-streaming block 2 (review F1). By list
      // position it is "newest"; it is not new content.
      const before = [msg('entry:a1', 'one', 'm1'), msg('sb:0', 'First live block', 'm'), msg('sb:2', 'Second', 'm', true)]
      const after = [msg('entry:a1', 'one', 'm1'), msg('sb:2', 'Second', 'm', true), msg('entry:b0', 'First live block', 'm')]
      expect(nextReaderSelection(before, 'sb:2', after, true)).toEqual({ id: 'sb:2', moved: false })
    })

    it('follows a new live block even when the ledger sorts it before an older committed one', () => {
      // Review F2: block 0 committed first, then block 2 starts and sorts above it.
      const before = [msg('entry:a1', 'one', 'm1'), msg('entry:b0', 'First live block', 'm')]
      const after = [msg('entry:a1', 'one', 'm1'), msg('sb:2', 'Second', 'm', true), msg('entry:b0', 'First live block', 'm')]
      expect(nextReaderSelection(before, 'entry:b0', after, true)).toEqual({ id: 'sb:2', moved: true })
    })

    it('prefers a new page over the committed twin when both arrive together', () => {
      const before = [msg('a', 'one', 'm1'), msg('sb:0', 'First', 'm', true)]
      const after = [msg('a', 'one', 'm1'), msg('entry:b0', 'First', 'm'), msg('sb:9', 'Next turn', 'n', true)]
      expect(nextReaderSelection(before, 'sb:0', after, true)).toEqual({ id: 'sb:9', moved: true })
    })
  })

  describe('not following (the reader chose, or scrolled into, a message)', () => {
    it('stays on the message while new pages arrive', () => {
      // Review F3: a reader half-way down a finished plan must not be pulled to
      // the next turn and lose their place.
      const before = [msg('a', 'one'), msg('plan', 'The plan', 'm1')]
      const after = [msg('a', 'one'), msg('plan', 'The plan', 'm1'), msg('next', 'Now I will run the tests.', 'm2', true)]
      expect(nextReaderSelection(before, 'plan', after, false)).toEqual({ id: 'plan', moved: false })
    })

    it('moves onto the committed twin of the selected message without counting it as a move', () => {
      const before = [msg('entry:a1', 'one', 'm1'), msg('sb:m2:0', 'Second answer', 'm2'), msg('live', 'three', 'm3', true)]
      const after = [msg('entry:a1', 'one', 'm1'), msg('entry:a2', 'Second answer', 'm2'), msg('live', 'three', 'm3', true)]
      expect(nextReaderSelection(before, 'sb:m2:0', after, false)).toEqual({ id: 'entry:a2', moved: false })
    })

    it('follows one block into the entry that joins several blocks of its turn', () => {
      // Review B round 2: Claude's whole-turn suppression (committed message.id
      // == turnId) can replace two semantic pages with ONE joined entry. Neither
      // page's text equals the joined text, so identity has to lead.
      const before = [
        msg('entry:a0', 'Earlier answer', 'm0'),
        msg('sb:m1:0', 'Part one.', 'm1'),
        msg('sb:m1:2', 'Part two.', 'm1'),
        msg('live', 'next', 'm3', true),
      ]
      const after = [
        msg('entry:a0', 'Earlier answer', 'm0'),
        msg('entry:a1', 'Part one.\n\nPart two.', 'm1'),
        msg('live', 'next', 'm3', true),
      ]
      expect(nextReaderSelection(before, 'sb:m1:0', after, false)).toEqual({ id: 'entry:a1', moved: false })
    })

    it('falls back to the ledger-normalised text when there is no shared source id', () => {
      const before = [msg('x', 'first'), msg('sem', 'Second  answer', null), msg('live', 'z', null, true)]
      const after = [msg('x', 'first'), msg('entry:a2', 'Second answer', 'resp_2'), msg('live', 'z', null, true)]
      expect(nextReaderSelection(before, 'sem', after, false)).toEqual({ id: 'entry:a2', moved: false })
    })

    it('picks the text twin nearest the old position when the same text appears twice', () => {
      const before = [msg('e1', 'Done.'), msg('mid', 'work'), msg('sem', 'Done.'), msg('live', 'z', null, true)]
      const after = [msg('e1', 'Done.'), msg('mid', 'work'), msg('entry:a3', 'Done.'), msg('live', 'z', null, true)]
      expect(nextReaderSelection(before, 'sem', after, false)).toEqual({ id: 'entry:a3', moved: false })
    })

    it('keeps the same distance from the end when the selection vanishes without a twin', () => {
      // e.g. a semantic-history turn evicted by the history cap.
      const before = [msg('a', 'one'), msg('b', 'two'), msg('c', 'three'), msg('d', 'four', null, true)]
      const after = [msg('a', 'one'), msg('c', 'three'), msg('d', 'four', null, true)]
      expect(nextReaderSelection(before, 'b', after, false)).toEqual({ id: 'a', moved: true })
    })
  })

  it('is idempotent, so applying a result and reconciling again changes nothing', () => {
    // ReaderView reconciles during render and re-renders immediately after
    // applying the result against the SAME previous list. A second answer that
    // differed (or reported a move again) would loop the render.
    const cases: Array<[ReaderMessage[], string, ReaderMessage[], boolean]> = [
      [[msg('a', 'one'), msg('b0', 'First', 'm', true)], 'b0', [msg('a', 'one'), msg('b0', 'First', 'm'), msg('b2', 'Second', 'm', true)], true],
      [[msg('e', 'one', 'm1'), msg('sb', 'Two', 'm2'), msg('l', 'z', 'm3', true)], 'sb', [msg('e', 'one', 'm1'), msg('entry', 'Two', 'm2'), msg('l', 'z', 'm3', true)], false],
      [[msg('a', 'one'), msg('b', 'two'), msg('c', 'three')], 'b', [msg('a', 'one'), msg('c', 'three')], false],
    ]
    for (const [previous, previousId, next, following] of cases) {
      const first = nextReaderSelection(previous, previousId, next, following)
      expect(nextReaderSelection(previous, first.id, next, following)).toEqual({ id: first.id, moved: false })
    }
  })
})
