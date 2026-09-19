import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionNativeInput } from '@shared/types/extensionInput'
import { bindExtensionFrameInput } from './nativeInput'

let receive: (message: ExtensionNativeInput) => void
const disposers: Array<() => void> = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const unsubscribed = vi.fn()
beforeEach(() => {
  unsubscribed.mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onExtensionNativeInput: (handler: typeof receive) => { receive = handler; return unsubscribed },
  } })
})
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})
function frame(instance: string, focus: () => void = vi.fn()) {
  const element = document.createElement('iframe')
  // This suite tests parent DOM/IPC routing. Electron covers actual custom-scheme
  // navigation; connect about:blank before replacing the URL property so
  // happy-dom's connection hook cannot fetch a protocol it cannot serve.
  document.body.append(element)
  Object.defineProperty(element, 'src', { configurable: true, writable: true,
    value: `agent-code-ext://example/__bundle/rev/__agent-code-frame__.html?instance=${instance}` })
  disposers.push(bindExtensionFrameInput(element, focus))
  return element
}
function key(url: string): ExtensionNativeInput {
  return { kind: 'key', url, type: 'keydown', input: { key: 'W', code: 'KeyW', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false } }
}

it('selects the actual focused frame before routing exactly one native key through the document', () => {
  const order: string[] = []
  const element = frame('one', () => order.push('focus'))
  const listener = (event: KeyboardEvent) => { if (event.target === element) order.push(event.code) }
  document.addEventListener('keydown', listener)
  try {
    element.focus()
    receive(key(element.src))
    expect(order).toEqual(['focus', 'KeyW'])
  } finally { document.removeEventListener('keydown', listener) }
})

it('does not accept child-shaped postMessage as a native input event', () => {
  const focused = vi.fn()
  const element = frame('one', focused)
  element.focus()
  window.dispatchEvent(new MessageEvent('message', { data: key(element.src), source: element.contentWindow, origin: 'agent-code-ext://example' }))
  expect(focused).not.toHaveBeenCalled()
})

it('preserves repeat and release semantics for the existing shortcut hold controller', () => {
  const element = frame('one')
  const events: Array<{ type: string; code: string; repeat: boolean; meta: boolean }> = []
  const listener = (event: KeyboardEvent) => events.push({ type: event.type, code: event.code, repeat: event.repeat, meta: event.metaKey })
  document.addEventListener('keydown', listener)
  document.addEventListener('keyup', listener)
  try {
    element.focus()
    const down = key(element.src)
    if (down.kind !== 'key') throw new Error('Expected key fixture')
    receive(down)
    receive({ ...down, input: { ...down.input, repeat: true } })
    receive({ ...down, type: 'keyup', input: { ...down.input, metaKey: false } })
    expect(events).toEqual([
      { type: 'keydown', code: 'KeyW', repeat: false, meta: true },
      { type: 'keydown', code: 'KeyW', repeat: true, meta: true },
      { type: 'keyup', code: 'KeyW', repeat: false, meta: false },
    ])
  } finally {
    document.removeEventListener('keydown', listener)
    document.removeEventListener('keyup', listener)
  }
})

it('does not route a key when selecting its pane moves focus into another surface', () => {
  const input = document.createElement('input')
  document.body.append(input)
  const element = frame('one', () => input.focus())
  const listener = vi.fn()
  element.addEventListener('keydown', listener)
  element.focus()
  receive(key(element.src))
  expect(document.activeElement).toBe(input)
  expect(listener).not.toHaveBeenCalled()
})

it('rejects events for another instance of the same extension and for an unfocused view', () => {
  const first = vi.fn(), second = vi.fn()
  const a = frame('one', first), b = frame('two', second)
  b.focus()
  receive(key(a.src))
  expect(first).not.toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
  receive({ kind: 'focus', url: b.src })
  expect(second).toHaveBeenCalledOnce()
})

it('rejects a delayed native event after the same iframe element changes documents', () => {
  const focused = vi.fn()
  const element = frame('one', focused)
  const old = element.src
  element.src = old.replace('one', 'replacement')
  element.focus()
  receive(key(old))
  expect(focused).not.toHaveBeenCalled()
  receive(key(element.src))
  expect(focused).toHaveBeenCalledOnce()
})

it('routes keys for a view whose document changed only its own fragment or path', () => {
  // Main reports the frame's committed URL, which includes hash-router and
  // pushState edits, while iframe.src keeps the parent-set attribute. Matching
  // by full URL killed every app shortcut in such a pane.
  const focused = vi.fn()
  const element = frame('one', focused)
  element.focus()
  receive(key(`${element.src}#/settings`))
  expect(focused).toHaveBeenCalledOnce()
  receive(key(element.src.replace('__agent-code-frame__.html', 'settings')))
  expect(focused).toHaveBeenCalledTimes(2)
})

it('removes native ownership on disposal and releases the shared subscription after the last view', () => {
  const first = vi.fn(), second = vi.fn()
  const a = frame('one', first), b = frame('two', second)
  disposers.shift()!()
  expect(unsubscribed).not.toHaveBeenCalled()
  a.focus()
  receive(key(a.src))
  expect(first).not.toHaveBeenCalled()
  disposers.shift()!()
  expect(unsubscribed).toHaveBeenCalledOnce()
  b.focus()
  receive(key(b.src))
  expect(second).not.toHaveBeenCalled()
})
