import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { pickIntoComposer } from './pick'

// The pick lands in THIS session's composer at the caret (spec §4.7) — never
// another agent's, never a new chat, never blindly appended.
const RESULT = { url: 'http://localhost:3000/login', selector: '#go', role: 'button', name: 'Sign in', width: 320, height: 44, image: 'data:image/jpeg;base64,AAAA' }

function workspace(kind: string, draft: string) {
  const setDraftInput = vi.fn()
  const setDraftImages = vi.fn()
  const ws = {
    state: { sessions: { s1: { cwd: '/w', kind }, s2: { cwd: '/w', kind } } },
    runtimes: { s1: { draftInput: draft }, s2: { draftInput: 'other agent' } },
    setDraftInput, setDraftImages,
  } as unknown as Workspace
  return { ws, setDraftInput, setDraftImages }
}

function composer(sessionId: string, value: string, caret: number) {
  const el = document.createElement('textarea')
  el.setAttribute('data-composer-input', sessionId)
  el.value = value
  document.body.appendChild(el)
  el.setSelectionRange(caret, caret)
  return el
}

beforeEach(() => {
  window.api = { ...(window.api ?? {}), pickInPocket: vi.fn(async () => ({ kind: 'picked', result: RESULT })) } as unknown as typeof window.api
})
afterEach(() => { document.body.innerHTML = '' })

describe('pickIntoComposer', () => {
  it('inserts the element chip at the caret of the picking session\'s composer', async () => {
    composer('s2', 'other agent', 0)
    composer('s1', 'make this blue please', 10)
    const { ws, setDraftInput } = workspace('claude', 'make this blue please')
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), vi.fn())
    expect(setDraftInput).toHaveBeenCalledTimes(1)
    const [sessionId, text] = setDraftInput.mock.calls[0]!
    expect(sessionId).toBe('s1')
    expect(text).toMatch(/^make this <browser-element url="http:\/\/localhost:3000\/login" selector="#go" role="button" name="Sign in" size="320×44" \/> blue please$/)
  })

  it('attaches the element screenshot for providers that take images', async () => {
    composer('s1', '', 0)
    const { ws, setDraftImages } = workspace('claude', '')
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), vi.fn())
    expect(setDraftImages).toHaveBeenCalledWith('s1', expect.any(Function))
  })

  it('without a composer (terminal-surface agent) copies the chip and says so, instead of typing into a TUI', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    const { ws, setDraftInput } = workspace('claude', '')
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), toast)
    expect(setDraftInput).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('<browser-element'))
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/copied/i))
  })

  it('a cancelled pick changes nothing and says nothing', async () => {
    window.api = { ...(window.api ?? {}), pickInPocket: vi.fn(async () => ({ kind: 'cancelled' })) } as unknown as typeof window.api
    composer('s1', 'draft', 5)
    const { ws, setDraftInput } = workspace('claude', 'draft')
    const toast = vi.fn()
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), toast)
    expect(setDraftInput).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  // #1305: a failed pick used to look exactly like a cancel. Each reason is
  // said in fixed words, and an IPC rejection is said as a failure too.
  it.each([
    ['devtools-open', "Close the pocket's DevTools to pick an element."],
    ['unavailable', "The browser pocket isn't available for picking right now."],
    ['error', "Couldn't pick an element. Try again."],
  ])('says a %s failure', async (reason, sentence) => {
    window.api = { ...(window.api ?? {}), pickInPocket: vi.fn(async () => ({ kind: 'failed', reason })) } as unknown as typeof window.api
    composer('s1', 'draft', 5)
    const { ws, setDraftInput } = workspace('claude', 'draft')
    const toast = vi.fn()
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), toast)
    expect(toast.mock.calls).toEqual([[sentence]])
    expect(setDraftInput).not.toHaveBeenCalled()
  })

  it('says a rejected request as a failure, not a cancel', async () => {
    window.api = { ...(window.api ?? {}), pickInPocket: vi.fn(async () => { throw new Error('IPC gone') }) } as unknown as typeof window.api
    const { ws } = workspace('claude', 'draft')
    const toast = vi.fn()
    await pickIntoComposer('p1', 's1' as never, ws, vi.fn(), toast)
    expect(toast.mock.calls).toEqual([["Couldn't pick an element. Try again."]])
  })
})
