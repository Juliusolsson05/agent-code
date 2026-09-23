import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromiumExecutable, chromiumHarness } from '../testing/chromiumHarness'
import { BrowserPocketController } from './BrowserPocketController'
import { snapshot, clickNode, typeInto, screenshot, waitFor, navigate, pressKey, scroll } from './actions'

describe.skipIf(!chromiumExecutable)('embedded browser actions against real Chromium', { timeout: 20_000 }, () => {
  let fixture: Awaited<ReturnType<typeof chromiumHarness>>
  let controller: BrowserPocketController
  let server: Server
  let url: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(req.url === '/frame' ? '<label>Cross-site<input></label>' : req.url === '/next' ? '<h1>Next page</h1>' : `<h1>Form</h1><label>Draft<input></label><iframe src="http://localhost:${(server.address() as AddressInfo).port}/frame"></iframe>`)
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    fixture = await chromiumHarness()
    controller = new BrowserPocketController({ now: Date.now, emitDriving: () => {}, requestOpen: () => {}, setWatchedSessions: () => {}, lanePorts: () => [], requestViewport: () => {} })
    controller.setFlags({ enabled: true, allowEvaluate: false })
    controller.register('pocket', 'agent', fixture.guest)
  }, 20_000)
  afterAll(async () => { await controller?.unregister('pocket'); await fixture?.cleanup(); await new Promise<void>(resolve => server?.close(() => resolve())) })

  it('reads iframe controls and fills/clicks them by library-issued refs', async () => {
    await fixture.page.setContent(`<h1>Outer page</h1><iframe srcdoc='<label>Name<input></label><button onclick="this.textContent=123">Save</button>'></iframe>`)
    const result = await controller.run('agent', 'snapshot', snapshot)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const name = /textbox "Name"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)?.[1]
    const save = /button "Save"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)?.[1]
    expect(name, result.value.text).toBeTruthy()
    expect(save, result.value.text).toBeTruthy()
    expect(await controller.run('agent', 'type', ctx => typeInto(ctx, name!, 'Julius', { clear: true }), { mutating: true })).toMatchObject({ ok: true })
    expect(await controller.run('agent', 'click', ctx => clickNode(ctx, save!), { mutating: true })).toMatchObject({ ok: true })
    expect(await fixture.page.frameLocator('iframe').getByRole('textbox').inputValue()).toBe('Julius')
    expect(await fixture.page.frameLocator('iframe').getByRole('button').textContent()).toBe('123')
  })

  it('waits for an overlay to leave instead of clicking the element covering the requested button', async () => {
    await fixture.page.setContent(`<button id="save" onclick="this.textContent='Saved'">Save</button><div id="cover" style="position:fixed;inset:0;background:white" onclick="this.textContent='Wrong target'"></div>`)
    const result = await controller.run('agent', 'snapshot', snapshot)
    if (!result.ok) throw new Error(result.message)
    const ref = /button "Save"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)![1]!
    const pending = controller.run('agent', 'click', ctx => clickNode(ctx, ref), { mutating: true })
    await fixture.page.waitForTimeout(150)
    expect(await fixture.page.locator('#cover').textContent()).toBe('')
    await fixture.page.locator('#cover').evaluate(el => el.remove())
    expect(await pending).toMatchObject({ ok: true })
    expect(await fixture.page.locator('#save').textContent()).toBe('Saved')
  })

  it('human takeover cancels retries before a covered control becomes clickable', async () => {
    await fixture.page.setContent(`<button id="save" onclick="this.textContent='Clicked'">Save</button><div id="cover" style="position:fixed;inset:0"></div>`)
    const result = await controller.run('agent', 'snapshot', snapshot)
    if (!result.ok) throw new Error(result.message)
    const ref = /button "Save"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)![1]!
    const pending = controller.run('agent', 'click', ctx => clickNode(ctx, ref), { mutating: true })
    await fixture.page.waitForTimeout(150)
    controller.takeOver('pocket')
    expect(await pending).toMatchObject({ ok: false, code: 'user_took_control' })
    await fixture.page.locator('#cover').evaluate(el => el.remove())
    await fixture.page.waitForTimeout(150)
    expect(await fixture.page.locator('#save').textContent()).toBe('Save')
    controller.resume('pocket')
  })

  it('captures a real page image and waits for changing visible text', async () => {
    await fixture.page.setContent('<h1>Waiting</h1>')
    const waiting = controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Ready' }, 2000))
    await fixture.page.getByRole('heading').evaluate(el => { el.textContent = 'Ready' })
    expect(await waiting).toMatchObject({ ok: true })
    const result = await controller.run('agent', 'screenshot', screenshot)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(Buffer.from(result.value.jpegBase64, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]))
    expect(result.value.width).toBe(800)
  })
  it('routes cross-site iframe refs through child debugger sessions', async () => {
    await fixture.page.goto(url)
    await fixture.page.frameLocator('iframe').getByRole('textbox').waitFor()
    const result = await controller.run('agent', 'snapshot', snapshot)
    if (!result.ok) throw new Error(result.message)
    const ref = /textbox "Cross-site"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)?.[1]
    expect(ref, result.value.text).toBeTruthy()
    expect(await controller.run('agent', 'type', ctx => typeInto(ctx, ref!, 'Across frames', { clear: true }), { mutating: true })).toMatchObject({ ok: true })
    expect(await fixture.page.frameLocator('iframe').getByRole('textbox').inputValue()).toBe('Across frames')
  })

  it('targets the viewport centre after scrolling a sidebar by ref', async () => {
    await fixture.page.setContent(`<!doctype html><style>body{margin:0}aside{position:fixed;left:0;top:0;width:180px;height:600px;overflow:auto}main{position:fixed;left:200px;top:0;right:0;height:600px;overflow:auto}section{height:2400px}</style><aside aria-label="Sidebar"><section>Sidebar content</section></aside><main><section>Main content</section></main>`)
    const result = await controller.run('agent', 'snapshot', snapshot)
    if (!result.ok) throw new Error(result.message)
    const ref = /complementary "Sidebar"[^\n]*\[ref=([^\]]+)\]/.exec(result.value.text)?.[1]
    expect(ref, result.value.text).toBeTruthy()
    expect(await controller.run('agent', 'scroll', ctx => scroll(ctx, 0, 200, ref!), { mutating: true })).toMatchObject({ ok: true })
    await vi.waitFor(async () => expect(await fixture.page.locator('aside').evaluate(el => el.scrollTop)).toBeGreaterThan(0))
    expect(await controller.run('agent', 'scroll', ctx => scroll(ctx, 0, 200), { mutating: true })).toMatchObject({ ok: true })
    await vi.waitFor(async () => expect(await fixture.page.locator('main').evaluate(el => el.scrollTop)).toBeGreaterThan(0))
    expect(await fixture.page.locator('html').evaluate(el => el.getBoundingClientRect().height)).toBe(0)
    expect(await controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Main content', gone: 'Loading' }, 700))).toMatchObject({ ok: true })
  })

  it('does not combine text from the previous page with a later matching URL', async () => {
    await fixture.page.goto(url)
    await fixture.page.setContent('<h1>Ready</h1>')
    const pending = controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Ready', urlIncludes: '/next' }, 700))
    // Give the old independent text waiter time to resolve before navigation.
    // The destination deliberately never contains Ready, so success is wrong.
    await fixture.page.waitForTimeout(150)
    await fixture.page.goto(`${url}next`)
    expect(await pending).toMatchObject({ ok: false })
    await fixture.page.getByRole('heading').evaluate(el => { el.textContent = 'Ready' })
    expect(await controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Ready', urlIncludes: '/next' }, 700))).toMatchObject({ ok: true })
  })

  it('requires visible and absent text conditions to hold together', async () => {
    await fixture.page.setContent('<h1>Ready</h1><p>Loading</p>')
    const pending = controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Ready', gone: 'Loading' }, 700))
    await fixture.page.waitForTimeout(150)
    await fixture.page.locator('body').evaluate(el => { el.innerHTML = '<h1>Still waiting</h1>' })
    expect(await pending).toMatchObject({ ok: false })
    await fixture.page.getByRole('heading').evaluate(el => { el.textContent = 'Ready' })
    expect(await controller.run('agent', 'wait', ctx => waitFor(ctx, { text: 'Ready', gone: 'Loading' }, 700))).toMatchObject({ ok: true })
  })

  it('preserves form state when opening the current URL and waits for navigation', async () => {
    await fixture.page.goto(url)
    await fixture.page.getByRole('textbox', { name: 'Draft' }).fill('Keep this')
    expect(await controller.run('agent', 'open', ctx => navigate(ctx, url), { mutating: true })).toMatchObject({ ok: true, value: url })
    expect(await fixture.page.getByRole('textbox', { name: 'Draft' }).inputValue()).toBe('Keep this')
    expect(await controller.run('agent', 'navigate', ctx => navigate(ctx, `${url}next`), { mutating: true })).toMatchObject({ ok: true, value: `${url}next` })
    expect(await fixture.page.getByRole('heading').textContent()).toBe('Next page')
  })

  it('releases modifiers after an invalid chord before the next action', async () => {
    await fixture.page.setContent('<input aria-label="Editor">')
    await fixture.page.getByRole('textbox').focus()
    const bad = await controller.run('agent', 'press', ctx => pressKey(ctx, 'NotAKey', ['Ctrl']), { mutating: true })
    expect(bad.ok).toBe(false)
    expect(await controller.run('agent', 'press', ctx => pressKey(ctx, 'a', []), { mutating: true })).toMatchObject({ ok: true })
    expect(await fixture.page.getByRole('textbox').inputValue()).toBe('a')
  })

  it('unwinds a modifier when takeover interrupts the next chord step', async () => {
    await fixture.page.setContent('<input aria-label="Editor">')
    await fixture.page.getByRole('textbox').focus()
    const nativeSend = fixture.guest.debugger.sendCommand.bind(fixture.guest.debugger)
    const intercepted = vi.spyOn(fixture.guest.debugger, 'sendCommand').mockImplementation(async (method, params, session) => {
      const result = await nativeSend(method, params, session)
      const input = params as { type?: string; key?: string }
      if (method === 'Input.dispatchKeyEvent' && input.type === 'rawKeyDown' && input.key === 'Control') controller.takeOver('pocket')
      return result
    })
    try {
      expect(await controller.run('agent', 'press', ctx => pressKey(ctx, 'a', ['Ctrl']), { mutating: true })).toMatchObject({ ok: false, code: 'user_took_control' })
    } finally { intercepted.mockRestore(); controller.resume('pocket') }
    expect(await controller.run('agent', 'press', ctx => pressKey(ctx, 'b', []), { mutating: true })).toMatchObject({ ok: true })
    expect(await fixture.page.getByRole('textbox').inputValue()).toBe('b')
  })

})
