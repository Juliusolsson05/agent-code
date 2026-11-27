import { describe, expect, it, vi } from 'vitest'

import {
  attachOsc52ClipboardHandler,
  parseOsc52ClipboardWrite,
} from '@renderer/workspace/terminal/osc52Clipboard'

describe('OSC 52 write-only clipboard handler', () => {
  it('decodes valid UTF-8 base64 payloads and writes to the clipboard', () => {
    let registeredCallback: ((data: string) => boolean) | null = null
    const dispose = vi.fn()
    const term = {
      parser: {
        registerOscHandler: vi.fn((ident: number, cb: (data: string) => boolean) => {
          expect(ident).toBe(52)
          registeredCallback = cb
          return { dispose }
        }),
      },
    }
    const writeClipboard = vi.fn()

    const handle = attachOsc52ClipboardHandler(term as never, writeClipboard)
    expect(registeredCallback).not.toBeNull()

    // "hello — 世界" encoded as UTF-8 base64.
    const payload = Buffer.from('hello — 世界', 'utf8').toString('base64')
    expect(registeredCallback!(`c;${payload}`)).toBe(true)
    expect(writeClipboard).toHaveBeenCalledTimes(1)
    expect(writeClipboard).toHaveBeenCalledWith('hello — 世界')

    handle.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores clipboard read queries (?) without touching the clipboard', () => {
    let registeredCallback: ((data: string) => boolean) | null = null
    const term = {
      parser: {
        registerOscHandler: (_ident: number, cb: (data: string) => boolean) => {
          registeredCallback = cb
          return { dispose: () => {} }
        },
      },
    }
    const writeClipboard = vi.fn()

    attachOsc52ClipboardHandler(term as never, writeClipboard)

    // Both `c;?` and `;?` are standard OSC 52 read queries.
    expect(registeredCallback!('c;?')).toBe(true)
    expect(registeredCallback!(';?')).toBe(true)
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('rejects malformed, empty, or oversized (> 1 MiB) payloads', () => {
    expect(parseOsc52ClipboardWrite('no-semicolon')).toBeNull()
    expect(parseOsc52ClipboardWrite('c;')).toBeNull()
    expect(parseOsc52ClipboardWrite('c;%%%not-base64%%%')).toBeNull()

    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61).toString('base64')
    expect(parseOsc52ClipboardWrite(`c;${oversized}`)).toBeNull()
  })
})
