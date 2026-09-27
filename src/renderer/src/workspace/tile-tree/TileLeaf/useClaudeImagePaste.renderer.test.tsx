import { readFileSync } from 'node:fs'

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useClaudeImagePaste } from './useClaudeImagePaste'

// #1250 row 7: only Claude's composer takes pasted images. A screenshot
// pasted into a Codex, OpenCode, Grok or Pi composer was dropped with nothing
// said.
//
// The REAL hook with the real provider capabilities. The image bytes are a
// RECORDED user attachment (testing/fixtures/image-reads/claude-user-attachment.json);
// the paste event's clipboardData, and navigator.clipboard.read for the async
// case, are the stubbed edges, shaped as the browser gives them.

const recorded = JSON.parse(readFileSync('testing/fixtures/image-reads/claude-user-attachment.json', 'utf8')) as {
  entry: { message: { content: Array<{ source?: { data: string; media_type: string } }> } }
}
const source = recorded.entry.message.content[1]!.source!
const png = new File([Buffer.from(source.data, 'base64')], 'screenshot.png', { type: source.media_type })
const dataUrlImg = `<img src="data:${source.media_type};base64,${source.data}">`

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function paste(options: { image?: boolean; text?: string; html?: string; items?: Array<{ kind: string; type: string }> }) {
  const items = options.items ?? (options.image ? [{ kind: 'file', type: png.type, getAsFile: () => png }] : [])
  return {
    clipboardData: {
      items,
      getData: (type: string) => (type === 'text/plain' ? options.text ?? '' : type === 'text/html' ? options.html ?? '' : ''),
    } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  }
}

function hook(provider: 'codex' | 'opencode' | 'grok' | 'pi' | 'claude') {
  const showToast = vi.fn()
  const setDraftImages = vi.fn()
  const { result } = renderHook(() => useClaudeImagePaste({ provider, sessionId: 's1' as never, setDraftImages, showToast }))
  return { handlePaste: result.current.handlePaste, showToast, setDraftImages }
}

describe('pasting an image into a composer that cannot take one', () => {
  // Each provider is named: the sentence is built from its label (#1426 review a).
  it.each([
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
    ['grok', 'Grok'],
    ['pi', 'Pi'],
  ] as const)('says so for an image-only paste into %s', async (provider, label) => {
    const { handlePaste, showToast } = hook(provider)
    let answer: unknown
    await act(async () => { answer = await handlePaste(paste({ image: true })) })
    expect(showToast).toHaveBeenCalledWith(`Pasted images can't be sent to ${label} from this composer.`)
    expect(answer).toEqual({ handledImages: false })
  })

  // #1426 review b: "see attached" with the attachment silently dropped.
  it('says the image was left out of an image-plus-text paste', async () => {
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({ image: true, text: 'see attached' })) })
    expect(showToast).toHaveBeenCalledWith("Pasted images can't be sent to Codex from this composer; only the text was pasted.")
  })

  // #1426 review a, b: a browser image copy that arrives only as a data-URL
  // <img> in text/html.
  it('says so for an image that arrives only as HTML', async () => {
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({ html: dataUrlImg })) })
    expect(showToast).toHaveBeenCalledWith("Pasted images can't be sent to Codex from this composer.")
  })

  // #1426 review a: an image only the async clipboard API shows.
  it('says so for an image only the async clipboard shows', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read: vi.fn(async () => [{ types: [png.type], getType: async () => png }]) },
    })
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({})) })
    expect(showToast).toHaveBeenCalledWith("Pasted images can't be sent to Codex from this composer.")
  })

  it('stays silent for plain text, and for a web-page copy (an <img> beside its text)', async () => {
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({ text: 'hello' })) })
    await act(async () => { await handlePaste(paste({ text: 'an article', html: `<p>an article</p>${dataUrlImg}` })) })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('does not say it for Claude, which takes the image', async () => {
    const { handlePaste, showToast, setDraftImages } = hook('claude')
    let answer: unknown
    await act(async () => { answer = await handlePaste(paste({ image: true })) })
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining("can't be sent"))
    // Taken, not just unmentioned (#1426 review c).
    expect(answer).toEqual({ handledImages: true })
    expect(setDraftImages).toHaveBeenCalled()
  })

  // #1426 review c: only an IMAGE FILE counts. A PDF, a type-less Finder file,
  // or a string item that happens to say image/* is not an image paste, and a
  // missing clipboardData says nothing.
  it('stays silent for a non-image file, a string item, and no clipboard data', async () => {
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({ items: [{ kind: 'file', type: 'application/pdf' }] })) })
    await act(async () => { await handlePaste(paste({ items: [{ kind: 'file', type: '' }] })) })
    await act(async () => { await handlePaste(paste({ items: [{ kind: 'string', type: 'image/png' }] })) })
    await act(async () => { await handlePaste({ clipboardData: null, preventDefault: vi.fn() }) })
    expect(showToast).not.toHaveBeenCalled()
  })
})
