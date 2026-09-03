import { describe, expect, it, vi } from 'vitest'

import { createTerminalInputForwarder } from './terminalInputForwarder'

// #745: replies xterm generates while parsing a replay must never reach the
// provider; live input must, coalesced per tick.

/** A stand-in xterm: `write` synchronously "parses" the chunk by emitting
 *  the given replies through `onData`, then invokes the callback on the
 *  next microtask, which is when the real xterm reports the write done. */
function fakeTerminal(repliesFor: (chunk: string) => string[], onData: (data: string) => void) {
  return {
    write(chunk: string, callback?: () => void) {
      for (const reply of repliesFor(chunk)) onData(reply)
      if (callback) queueMicrotask(callback)
    },
  }
}

describe('terminalInputForwarder', () => {
  it('drops everything xterm emits while a replay is being parsed', async () => {
    const send = vi.fn()
    const forwarder = createTerminalInputForwarder(send)
    const dropped: boolean[] = []
    const term = fakeTerminal(
      chunk => (chunk.includes('\x1b[6n') ? ['\x1b[12;40R', '\x1b[?62;22c'] : []),
      data => { dropped.push(!forwarder.onData(data)) },
    )

    const done = forwarder.replay(term, ['prompt \x1b[6n', 'more \x1b[6n'])
    expect(forwarder.replaying).toBe(true)
    await done
    await Promise.resolve()

    expect(forwarder.replaying).toBe(false)
    expect(dropped).toEqual([true, true, true, true])
    expect(send).not.toHaveBeenCalled()
  })

  it('forwards live data after the replay has been parsed, coalesced per tick', async () => {
    const send = vi.fn()
    const forwarder = createTerminalInputForwarder(send)
    const term = fakeTerminal(() => [], () => {})
    await forwarder.replay(term, ['hello'])

    expect(forwarder.onData('a')).toBe(true)
    expect(forwarder.onData('b')).toBe(true)
    expect(forwarder.onData('\x1b[A')).toBe(true)
    expect(send).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ab\x1b[A')

    forwarder.onData('c')
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('c')
  })

  it('resolves an empty replay immediately without holding the latch', async () => {
    const send = vi.fn()
    const forwarder = createTerminalInputForwarder(send)
    const term = fakeTerminal(() => [], () => {})
    await forwarder.replay(term, ['', ''])
    expect(forwarder.replaying).toBe(false)
    expect(forwarder.onData('x')).toBe(true)
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith('x')
  })

  it('keeps replay chunks in order and releases the latch only after the last one', async () => {
    const send = vi.fn()
    const forwarder = createTerminalInputForwarder(send)
    const written: string[] = []
    const callbacks: Array<() => void> = []
    const term = {
      write(chunk: string, callback?: () => void) {
        written.push(chunk)
        if (callback) callbacks.push(callback)
      },
    }
    const done = forwarder.replay(term, ['one', 'two'])
    expect(written).toEqual(['one', 'two'])
    callbacks[0]!()
    expect(forwarder.replaying).toBe(true)
    expect(forwarder.onData('typed')).toBe(false)
    callbacks[1]!()
    await done
    expect(forwarder.replaying).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
