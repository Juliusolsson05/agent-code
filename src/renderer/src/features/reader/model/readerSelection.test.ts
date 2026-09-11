import { describe, expect, it } from 'vitest'

import type { ReaderMessage } from './readerMessages'
import { nextReaderSelection } from './readerSelection'

const msg = (id: string, text: string, live = false): ReaderMessage => ({ id, text, live })

describe('nextReaderSelection', () => {
  it('starts on the newest message', () => {
    expect(nextReaderSelection([], null, [msg('a', 'one'), msg('b', 'two')]))
      .toEqual({ id: 'b', moved: true })
  })

  it('clears the selection when there is nothing to read', () => {
    expect(nextReaderSelection([msg('a', 'one')], 'a', [])).toEqual({ id: null, moved: true })
    expect(nextReaderSelection([], null, [])).toEqual({ id: null, moved: false })
  })

  it('stays put, unmoved, while the newest message grows in place', () => {
    const before = [msg('a', 'one'), msg('live', 'Stream', true)]
    const after = [msg('a', 'one'), msg('live', 'Streaming on', true)]
    expect(nextReaderSelection(before, 'live', after)).toEqual({ id: 'live', moved: false })
  })

  it('follows onto a newer message when the reader was on the newest one', () => {
    // A live turn's second text page, or the next turn: the reader was keeping
    // up with the agent, so it keeps up.
    const before = [msg('a', 'one'), msg('b0', 'First block', true)]
    const after = [msg('a', 'one'), msg('b0', 'First block'), msg('b2', 'Second', true)]
    expect(nextReaderSelection(before, 'b0', after)).toEqual({ id: 'b2', moved: true })
  })

  it('keeps an older message the reader chose while newer messages arrive', () => {
    const before = [msg('a', 'one'), msg('b', 'two', true)]
    const after = [msg('a', 'one'), msg('b', 'two'), msg('c', 'three', true)]
    expect(nextReaderSelection(before, 'a', after)).toEqual({ id: 'a', moved: false })
  })

  it('moves an older selection onto its committed twin without counting it as a move', () => {
    const before = [msg('entry:a1', 'one'), msg('semantic-block:m2:0', 'Second answer'), msg('live', 'three', true)]
    const after = [msg('entry:a1', 'one'), msg('entry:a2', 'Second answer'), msg('live', 'three', true)]
    expect(nextReaderSelection(before, 'semantic-block:m2:0', after))
      .toEqual({ id: 'entry:a2', moved: false })
  })

  it('matches the twin with the ledger normalisation, not byte equality', () => {
    // The ledger hands text over on a normalised match (NFKC, collapsed
    // whitespace), so the twin may differ in whitespace from the live copy.
    const before = [msg('x', 'first'), msg('semantic-block:m2:0', 'Second  answer'), msg('live', 'z', true)]
    const after = [msg('x', 'first'), msg('entry:a2', 'Second answer'), msg('live', 'z', true)]
    expect(nextReaderSelection(before, 'semantic-block:m2:0', after))
      .toEqual({ id: 'entry:a2', moved: false })
  })

  it('picks the twin nearest the old position when the same text appears twice', () => {
    const before = [msg('e1', 'Done.'), msg('mid', 'work'), msg('semantic-block:m3:0', 'Done.'), msg('live', 'z', true)]
    const after = [msg('e1', 'Done.'), msg('mid', 'work'), msg('entry:a3', 'Done.'), msg('live', 'z', true)]
    expect(nextReaderSelection(before, 'semantic-block:m3:0', after))
      .toEqual({ id: 'entry:a3', moved: false })
  })

  it('treats the newest live copy handed to a longer committed twin as the same message', () => {
    // The last render may have shown a partial live block before the final
    // text and its JSONL entry landed together.
    const before = [msg('a', 'one'), msg('semantic-block:m2:0', 'Partial answ', true)]
    const after = [msg('a', 'one'), msg('entry:a2', 'Partial answer, finished.')]
    expect(nextReaderSelection(before, 'semantic-block:m2:0', after))
      .toEqual({ id: 'entry:a2', moved: false })
  })

  it('keeps the same distance from the end when an older selection vanishes without a twin', () => {
    // e.g. a semantic-history turn evicted by the history cap. Holding the
    // distance from the end keeps the reader near where they were instead of
    // throwing them to the live end of the conversation.
    const before = [msg('a', 'one'), msg('b', 'two'), msg('c', 'three'), msg('d', 'four', true)]
    const after = [msg('a', 'one'), msg('c', 'three'), msg('d', 'four', true)]
    expect(nextReaderSelection(before, 'b', after)).toEqual({ id: 'a', moved: true })
  })
})
