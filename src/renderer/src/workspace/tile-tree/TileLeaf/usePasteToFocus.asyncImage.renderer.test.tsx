import { fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePasteToFocus } from './usePasteToFocus'

// #1426 verification a: a paste landing outside the composer (paste-to-focus)
// whose image only the async clipboard API shows arrives as an EMPTY event:
// no text, no HTML, no items. It never reached the shared image handler, so
// nothing was said (and Claude never attached it). It now does; ordinary text
// still appends synchronously and never calls the handler.

function Harness({ handlePaste }: { handlePaste: Parameters<typeof usePasteToFocus>[0]['handlePaste'] }) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  usePasteToFocus({ focused: true, sessionId: 's1' as never, inputRef, setDraftInput: vi.fn(), handlePaste })
  return <textarea aria-label="Composer" ref={inputRef} readOnly />
}

afterEach(() => { document.body.replaceChildren() })

describe('paste-to-focus and an async-only image', () => {
  it('hands an empty paste event to the image handler', () => {
    const handlePaste = vi.fn(async () => ({ handledImages: false }))
    render(<Harness handlePaste={handlePaste} />)
    fireEvent.paste(document.body, { clipboardData: new DataTransfer() })
    expect(handlePaste).toHaveBeenCalledTimes(1)
  })

  it('never hands ordinary text to it', () => {
    const handlePaste = vi.fn(async () => ({ handledImages: false }))
    render(<Harness handlePaste={handlePaste} />)
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'hello')
    fireEvent.paste(document.body, { clipboardData: clipboard })
    expect(handlePaste).not.toHaveBeenCalled()
  })
})
