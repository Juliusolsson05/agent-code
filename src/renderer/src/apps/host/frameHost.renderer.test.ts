import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import { createFrameHost, type FrameHostHandle } from './frameHost'
import { useAppStore } from '@renderer/app-state/hooks'

// #1151 design review, blocker 1: a view request that FAILED VALIDATION was
// dropped as if it were foreign traffic, so `await api.secrets.set('token', '')`
// never settled in a view while the same call rejected in a runtime. These run
// the real broker (createFrameHost + its message listener) against a stand-in
// iframe window and assert what the child would receive.
const ORIGIN = 'agent-code-ext://example'
const SECRET = 'sk-dummy-value-that-must-not-echo'

let host: FrameHostHandle | null = null
let child: { postMessage: ReturnType<typeof vi.fn> }
const serviceRequests: unknown[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  serviceRequests.length = 0
  Object.defineProperty(window, 'api', { configurable: true, value: {
    extensionGrantedCapabilities: async () => [],
    extensionsServiceRequest: async (...args: unknown[]) => { serviceRequests.push(args); return undefined },
  } })
  const iframe = document.createElement('iframe')
  child = { postMessage: vi.fn() }
  // The broker identifies the frame by its contentWindow; a stand-in lets the
  // test observe exactly what would be posted back to the child.
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: child })
  host = createFrameHost({ iframe, extensionId: 'example', bundleRevision: 'rev', api: {} as AgentCodeApiV1 })
})
afterEach(() => {
  host?.dispose(); host = null
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function send(data: unknown, source: unknown = child, origin = ORIGIN): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }))
}
const replies = () => child.postMessage.mock.calls.map(call => call[0] as { kind: string; id: string; ok: boolean; error?: string })

it.each([
  ['an empty secret value', { method: 'secrets.set', key: 'token', value: '' }, 'secrets.set'],
  ['a 4097-character secret value', { method: 'secrets.set', key: 'token', value: SECRET + 'x'.repeat(4097) }, 'secrets.set'],
  ['a secret key outside the grammar', { method: 'secrets.get', key: `../${SECRET}` }, 'secrets.get'],
  ['an unknown extra field', { method: 'net.fetch', url: 'https://api.example.com/', extra: SECRET }, 'net.fetch'],
])('answers %s with a rejection instead of leaving the promise pending', (_label, request, method) => {
  send({ kind: 'agent-code-ext:request', id: 'call-1', request })
  expect(replies()).toEqual([{ kind: 'agent-code-ext:reply', id: 'call-1', ok: false, error: `Invalid arguments for ${method}.` }])
  // Pinned to the extension's own origin, like every broker reply.
  expect(child.postMessage.mock.calls[0][1]).toBe(ORIGIN)
  expect(JSON.stringify(replies())).not.toContain(SECRET)
  expect(serviceRequests).toEqual([])
})

it('never echoes an unknown method name, which is child-controlled text', () => {
  send({ kind: 'agent-code-ext:request', id: 'call-2', request: { method: `steal:${SECRET}` } })
  expect(replies()).toEqual([{ kind: 'agent-code-ext:reply', id: 'call-2', ok: false, error: 'Unknown extension API request.' }])
})

it('still ignores traffic that is not ours or not from this frame', () => {
  send({ type: 'some-library-message', id: 'x' })
  send({ kind: 'agent-code-ext:request', request: { method: 'secrets.set' } }) // no correlation id: nobody to answer
  send({ kind: 'agent-code-ext:request', id: 'call-3', request: { method: 'secrets.set', key: 'token', value: '' } }, {}) // another window
  send({ kind: 'agent-code-ext:request', id: 'call-4', request: { method: 'secrets.set', key: 'token', value: '' } }, child, 'agent-code-ext://other')
  expect(child.postMessage).not.toHaveBeenCalled()
})

it('a valid request still reaches the main-process broker', async () => {
  // perform() checks the live installation generation; publish one matching
  // the frame's revision so the request is admitted.
  const previous = useAppStore.getState().installedExtensions
  useAppStore.setState({ installedExtensions: [{ manifest: { id: 'example' }, present: true, installation: { id: 'rev' } }] as never })
  try {
    send({ kind: 'agent-code-ext:request', id: 'call-5', request: { method: 'secrets.get', key: 'token' } })
    await vi.waitFor(() => expect(replies()).toEqual([{ kind: 'agent-code-ext:reply', id: 'call-5', ok: true, result: undefined }]))
    expect(serviceRequests).toEqual([['example', 'rev', { method: 'secrets.get', key: 'token' }]])
  } finally { useAppStore.setState({ installedExtensions: previous }) }
})
