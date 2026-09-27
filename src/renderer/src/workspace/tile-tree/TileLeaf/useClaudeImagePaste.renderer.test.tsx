import { readFileSync } from 'node:fs'

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useClaudeImagePaste } from './useClaudeImagePaste'

// #1250 row 7: only Claude takes pasted images. A screenshot pasted into a
// Codex, OpenCode, Grok or Pi composer inserted nothing and said nothing.
//
// The REAL hook with the real provider capabilities. The image bytes are a
// RECORDED user attachment (testing/fixtures/image-reads/claude-user-attachment.json);
// the paste event's clipboardData is the one stubbed edge, shaped as the
// browser gives it (items with kind/type/getAsFile, getData by type).

const recorded = JSON.parse(readFileSync('testing/fixtures/image-reads/claude-user-attachment.json', 'utf8')) as {
  entry: { message: { content: Array<{ source?: { data: string; media_type: string } }> } }
}
const source = recorded.entry.message.content[1]!.source!
const png = new File([Buffer.from(source.data, 'base64')], 'screenshot.png', { type: source.media_type })

function paste(options: { image: boolean; text?: string }) {
  const items = options.image ? [{ kind: 'file', type: png.type, getAsFile: () => png }] : []
  return {
    clipboardData: {
      items,
      getData: (type: string) => (type === 'text/plain' ? options.text ?? '' : ''),
    } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  }
}

function hook(provider: 'codex' | 'claude') {
  const showToast = vi.fn()
  const { result } = renderHook(() => useClaudeImagePaste({ provider, sessionId: 's1' as never, setDraftImages: vi.fn(), showToast }))
  return { handlePaste: result.current.handlePaste, showToast }
}

describe('pasting an image into an agent that cannot take one', () => {
  it('says so for an image-only paste', async () => {
    const { handlePaste, showToast } = hook('codex')
    let answer: unknown
    await act(async () => { answer = await handlePaste(paste({ image: true })) })
    expect(showToast).toHaveBeenCalledWith("Codex can't take pasted images.")
    // The text routing is unchanged: the caller still owns the text.
    expect(answer).toEqual({ handledImages: false })
  })

  it('stays silent when the paste also carries text, and for plain text', async () => {
    const { handlePaste, showToast } = hook('codex')
    await act(async () => { await handlePaste(paste({ image: true, text: 'see attached' })) })
    await act(async () => { await handlePaste(paste({ image: false, text: 'hello' })) })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('does not say it for Claude, which takes the image', async () => {
    const { handlePaste, showToast } = hook('claude')
    await act(async () => { await handlePaste(paste({ image: true })) })
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining("can't take pasted images"))
  })
})
