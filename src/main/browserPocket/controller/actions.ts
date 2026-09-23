import type { ActionCtx } from './BrowserPocketController.js'
import { withPocketPage } from './playwrightPage.js'

/** Browser interaction belongs to Playwright. Our old quad-centre clicks
 * could hit an overlay; handwritten keyboard maps and main-frame AX walks
 * missed normal browser behavior. The scoped transport supplies ownership
 * and cancellation while the maintained library supplies browser semantics. */
export async function snapshot(ctx: ActionCtx, opts: { maxChars?: number } = {}): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  return withPocketPage(ctx, async page => {
    const text = await page.ariaSnapshot({ mode: 'ai', signal: ctx.signal })
    const limit = opts.maxChars ?? 20_000
    const truncated = text.length > limit
    const clipped = truncated ? text.slice(0, limit).split('\n').slice(0, -1).join('\n') + '\n… (truncated)' : text
    return { url: page.url(), title: await page.title(), text: clipped, truncated }
  })
}

// Library-issued refs may include a frame prefix. Never let a tool argument
// turn into an arbitrary selector expression (or silently target the body).
export function validRef(ref: string): boolean { return /^(?:f\d+)?e\d+$/.test(ref) }
function selector(ref: string): string {
  if (!validRef(ref)) throw new Error('Use an element ref from a fresh browser_snapshot.')
  return `aria-ref=${ref}`
}

export async function clickNode(ctx: ActionCtx, ref: string): Promise<void> {
  return withPocketPage(ctx, page => page.locator(selector(ref)).click({ signal: ctx.signal }))
}
export async function clickAt(ctx: ActionCtx, x: number, y: number): Promise<void> {
  return withPocketPage(ctx, page => page.mouse.click(x, y))
}
export async function typeInto(ctx: ActionCtx, ref: string, text: string, opts: { clear?: boolean; submit?: boolean }): Promise<void> {
  return withPocketPage(ctx, async page => {
    await ctx.cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const field = page.locator(selector(ref))
    if (opts.clear) await field.fill(text, { signal: ctx.signal })
    else await field.pressSequentially(text, { signal: ctx.signal })
    if (opts.submit) await field.press('Enter', { signal: ctx.signal })
  })
}
export async function pressKey(ctx: ActionCtx, key: string, modifiers: Array<'Alt' | 'Ctrl' | 'Meta' | 'Shift'>): Promise<void> {
  return withPocketPage(ctx, async page => {
    await ctx.cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.keyboard.press([...modifiers.map(m => m === 'Ctrl' ? 'Control' : m), key].join('+'))
  })
}
export async function scroll(ctx: ActionCtx, deltaX: number, deltaY: number, ref?: string): Promise<void> {
  return withPocketPage(ctx, async page => {
    if (ref) await page.locator(selector(ref)).hover({ signal: ctx.signal })
    else {
      // A wheel uses Playwright's last pointer position, which could still be
      // over a sidebar from an earlier targeted action (or start at 0,0 under
      // a fixed header). Ref-less scrolling consistently targets the viewport
      // centre; Chromium still decides which scroll container receives it.
      const { cssVisualViewport } = await ctx.cdp.sendCommand('Page.getLayoutMetrics')
      await page.mouse.move(cssVisualViewport.clientWidth / 2, cssVisualViewport.clientHeight / 2)
    }
    await page.mouse.wheel(deltaX, deltaY)
  })
}
export async function waitFor(ctx: ActionCtx, cond: { text?: string; urlIncludes?: string; gone?: string }, timeoutMs: number): Promise<void> {
  return withPocketPage(ctx, async page => {
    // Independent promises latch past states: text on the old page and a
    // later matching URL could satisfy a wait without ever coexisting. One
    // locator checks both DOM conditions together, then the current URL is
    // rechecked after it resolves. A redirect while waiting retries against
    // the same deadline, never granting each condition a fresh timeout.
    let document = page.locator('html')
    if (cond.text) document = document.filter({ has: page.getByText(cond.text).filter({ visible: true }) })
    if (cond.gone) document = document.filter({ hasNot: page.getByText(cond.gone).filter({ visible: true }) })
    const deadline = performance.now() + timeoutMs
    const options = () => {
      const timeout = deadline - performance.now()
      if (timeout <= 0) throw new Error('Browser wait conditions did not hold together before the timeout.')
      return { timeout, signal: ctx.signal }
    }
    do {
      if (cond.urlIncludes) await page.waitForURL(url => url.href.includes(cond.urlIncludes!), { ...options(), waitUntil: 'domcontentloaded' })
      // Fixed-position apps can have a zero-height html box despite visible
      // content. Only the descendant text filters should require visibility.
      await document.waitFor({ ...options(), state: 'attached' })
      ctx.checkEpoch()
    } while (cond.urlIncludes && !page.url().includes(cond.urlIncludes))
  })
}

/** Native navigation history remains Chromium's. Playwright observes actual
 * navigation completion and errors instead of sleeping for 300ms and claiming
 * success even when loadURL rejected. Opening the same page preserves forms. */
export async function navigate(ctx: ActionCtx, target: string | 'back' | 'forward' | 'reload'): Promise<string> {
  return withPocketPage(ctx, async page => {
    const options = { waitUntil: 'domcontentloaded' as const, signal: ctx.signal }
    if (target === 'back') await page.goBack(options)
    else if (target === 'forward') await page.goForward(options)
    else if (target === 'reload') await page.reload(options)
    else if (page.url() !== target) await page.goto(target, options)
    else await page.waitForLoadState('domcontentloaded', { signal: ctx.signal })
    return page.url()
  })
}

export async function screenshot(ctx: ActionCtx, maxWidth = 1280): Promise<{ jpegBase64: string; width: number; height: number }> {
  return withPocketPage(ctx, async page => {
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 80, scale: 'css', timeout: 5000, signal: ctx.signal })
    const metrics = await ctx.cdp.sendCommand('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport
    const width = Math.round(viewport.clientWidth)
    const height = Math.round(viewport.clientHeight)
    if (width <= maxWidth) return { jpegBase64: jpeg.toString('base64'), width, height }
    // NativeImage is only a codec here. Page capture is owned by Playwright,
    // avoiding Electron capturePage's dependency on the visible compositor.
    const { nativeImage } = await import('electron')
    const small = nativeImage.createFromBuffer(jpeg).resize({ width: maxWidth })
    return { jpegBase64: small.toJPEG(80).toString('base64'), ...small.getSize() }
  })
}

/**
 * browser_evaluate, in an ISOLATED world: the page cannot see or tamper with
 * our code, and our code cannot be fooled by page-defined globals. T3 Code ran
 * its helpers in the page's own world and trusted a page-spoofable flag.
 */
export async function evaluateIsolated(ctx: ActionCtx, expression: string): Promise<string> {
  const { frameTree } = await ctx.cdp.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
  const { executionContextId } = await ctx.cdp.sendCommand('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'agent-code-pocket', grantUniveralAccess: false }) as { executionContextId: number }
  ctx.checkEpoch()
  const { result, exceptionDetails } = await ctx.cdp.sendCommand('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }) as { result: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text ?? 'Evaluation threw')
  const json = JSON.stringify(result.value ?? null) ?? 'null'
  return json.length > 65_536 ? `${json.slice(0, 65_536)}… (truncated)` : json
}
