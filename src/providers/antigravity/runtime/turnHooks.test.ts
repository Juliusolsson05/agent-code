import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { agyTurnObserver, openAgyTurnHooks } from './turnHooks.js'

it('reports one parent turn across invocations and waits for an allowed, fully idle stop', async () => {
  const send = vi.fn<Parameters<typeof agyTurnObserver>[1]>(async (event) => event === 'user-prompt-submit'
    ? { hookSpecificOutput: { additionalContext: 'Set your goal.' } } : {})
  const activity = vi.fn()
  const observe = agyTurnObserver(() => 'parent', send, activity)
  const parent = { conversationId: 'parent' }
  expect(await observe('/pre', { conversationId: 'child' })).toEqual({})
  expect(await observe('/pre', parent)).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'Set your goal.' } }] })
  await observe('/pre', parent)
  await observe('/tool', parent)
  const stop = { ...parent, terminationReason: 'model_stop', fullyIdle: true }
  await observe('/stop', { ...stop, fullyIdle: false })
  expect(send.mock.calls.flat()).toEqual(['user-prompt-submit', 'post-tool-use'])
  send.mockImplementationOnce(async () => ({ decision: 'block', reason: 'Update your TLDR.' }))
  expect(await observe('/stop', stop)).toEqual({ decision: 'continue', reason: 'Update your TLDR.' })
  expect(activity.mock.calls.flat()).toEqual([true])
  await observe('/pre', parent)
  await observe('/stop', stop)
  await observe('/stop', stop)
  expect(send.mock.calls.flat()).toEqual(['user-prompt-submit', 'post-tool-use', 'stop', 'stop'])
  expect(activity.mock.calls.flat()).toEqual([true, false])
})

it('sends only the boundary to the pane host when the generated CLI command runs', async () => {
  const seen: unknown[] = []
  const host = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push([req.url, req.headers.authorization, Buffer.concat(chunks).toString()])
    res.end(JSON.stringify({ hookSpecificOutput: { additionalContext: 'Report your goal.' } }))
  })
  host.listen(0, '127.0.0.1')
  await once(host, 'listening')
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  const url = 'http://127.0.0.1:' + address.port
  const hooks = await openAgyTurnHooks([{ name: 'agent_code', url, headers: {}, bearerToken: 'local-test-token', tldrHooks: { baseUrl: url } }], () => 'local-pane')
  try {
    const raw = await readFile(join(hooks!.workspace, '.agents', 'hooks.json'), 'utf8')
    expect(raw).not.toContain('local-test-token')
    const command = JSON.parse(raw)['agent-code-reporting'].PreInvocation[0].command
    const child = spawn('/bin/sh', ['-c', command])
    const exited = once(child, 'close')
    child.stdin.end(JSON.stringify({ conversationId: 'local-pane', lastUserInput: 'private-example' }))
    const chunks = []
    for await (const chunk of child.stdout) chunks.push(chunk)
    expect((await exited)[0]).toBe(0)
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'Report your goal.' } }] })
    expect(seen).toEqual([['/user-prompt-submit', 'Bearer local-test-token', '{}']])
  } finally {
    await hooks?.close()
    host.closeAllConnections()
    host.close()
  }
})

it('pauses on an interrupted turn or failed stop and accepts the next turn', async () => {
  const send = vi.fn<Parameters<typeof agyTurnObserver>[1]>(async () => ({}))
  const activity = vi.fn()
  const observe = agyTurnObserver(() => 'pane', send, activity)
  const input = { conversationId: 'pane', fullyIdle: true }
  await observe('/pre', input)
  await observe('/stop', { ...input, terminationReason: 'error' })
  await observe('/pre', input)
  send.mockRejectedValueOnce(new Error('Host closed'))
  await expect(observe('/stop', { ...input, terminationReason: 'model_stop' })).rejects.toThrow('Host closed')
  await observe('/pre', input)
  expect(activity.mock.calls).toEqual([[true], [false, true], [true], [false, true], [true]])
})
