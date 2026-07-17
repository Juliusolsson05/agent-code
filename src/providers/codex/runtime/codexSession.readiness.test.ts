import { describe, expect, it } from 'vitest'

import { CodexSession } from './codexSession.js'

describe('CodexSession composer readiness', () => {
  it('latches the first real composer and does not flap while Codex works', () => {
    const session = new CodexSession()
    const seen: boolean[] = []
    session.on('input-readiness', input => seen.push(input.ready))
    const observe = (screen: string): void => {
      ;(session as unknown as { markComposerReady(value: string): void })
        .markComposerReady(screen)
    }

    observe('Do you trust the contents of this directory?\nYes, continue\nNo, quit')
    observe('›  Ask anything\n gpt-5 · medium')
    observe('Working (12s)\n gpt-5 · medium')
    observe('›  Ask anything else\n gpt-5 · medium')

    expect(seen).toEqual([true])
  })
})
