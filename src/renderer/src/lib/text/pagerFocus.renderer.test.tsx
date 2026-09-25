import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { OutputWell } from '@renderer/lib/text/OutputWell'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { TEXT_PAGE_MAX_LINES } from '@renderer/lib/text/boundedText'

// Feed disclosures that swap controls keep keyboard focus (ledger G-36).
// Before this, the pressed control unmounted: "next" onto the last page, and
// "(show all)" becoming "collapse". Focus fell to <body>, and the next Tab
// started again from the top of the document.
//
// Fixture: numbered lines, because only length drives these contracts (page
// boundaries, the head+tail window). The line text itself is irrelevant.
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('feed pager focus', () => {
  it('keeps focus on "next" when it pages onto the last page, and says the end is reached', () => {
    render(<PagedTextViewer source={lines(TEXT_PAGE_MAX_LINES + 10)} />)
    const next = screen.getByRole('button', { name: 'next' })
    next.focus()
    fireEvent.click(next)
    expect(document.activeElement).toBe(next)
    expect(next).toHaveAttribute('aria-disabled', 'true')
    // An end is a no-op: the same page, the same range. Without the guard,
    // a disabled "next" pushed a page start past the end (an empty page).
    const range = () => screen.getByText(/^characters/).textContent
    const page = () => document.querySelector('pre')!.textContent
    const [lastRange, lastPage] = [range(), page()]
    fireEvent.click(next)
    expect(range()).toBe(lastRange)
    expect(page()).toBe(lastPage)
    expect(screen.getByRole('button', { name: 'previous' })).not.toHaveAttribute('aria-disabled')
  })

  it('announces the start as unavailable instead of hiding "previous", and does nothing there', () => {
    render(<PagedTextViewer source={lines(TEXT_PAGE_MAX_LINES + 10)} />)
    const previous = screen.getByRole('button', { name: 'previous' })
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    const range = screen.getByText(/^characters/).textContent
    const page = document.querySelector('pre')!.textContent
    fireEvent.click(previous)
    expect(screen.getByText(/^characters/).textContent).toBe(range)
    expect(document.querySelector('pre')!.textContent).toBe(page)
  })
})

describe('OutputWell show all / collapse focus', () => {
  it('hands focus from "(show all)" to "collapse" and back', () => {
    render(<OutputWell text={lines(40)} ansi={false} previewLines={3} />)
    const showAll = screen.getByRole('button', { name: /show all/ })
    showAll.focus()
    fireEvent.click(showAll)
    const collapse = screen.getByRole('button', { name: 'collapse' })
    expect(document.activeElement).toBe(collapse)

    fireEvent.click(collapse)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /show all/ }))
  })

  it('does not move focus when the swap was not pressed from the keyboard focus', () => {
    render(<OutputWell text={lines(40)} ansi={false} previewLines={3} />)
    fireEvent.click(screen.getByRole('button', { name: /show all/ }))
    expect(document.activeElement).toBe(document.body)
  })
})

describe('CodeBlock paged content focus', () => {
  it('hands focus from "view paged content" to the pager\'s "next", and back on collapse', async () => {
    const { CodeBlock } = await import('@renderer/lib/code/CodeBlock')
    render(<CodeBlock code={lines(TEXT_PAGE_MAX_LINES * 3)} language="text" highlight={false} />)
    const open = screen.getByRole('button', { name: 'view paged content' })
    open.focus()
    fireEvent.click(open)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'next' }))

    const collapse = screen.getByRole('button', { name: 'collapse' })
    collapse.focus()
    fireEvent.click(collapse)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'view paged content' }))
  })
})
