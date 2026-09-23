import { formatAxTree, type AXNode, type AxSnapshot } from '../core/axSnapshot.js'
import { clickPointFromQuads } from '../core/geometry.js'

import type { ActionCtx } from './BrowserPocketController.js'

// CDP page actions for the `browser_*` tools. Each takes the controller's
// ActionCtx, so the queue, deadline and control epoch always apply.

export async function snapshot(ctx: ActionCtx, opts: { maxChars?: number } = {}): Promise<{ url: string; title: string } & AxSnapshot> {
  const { nodes } = await ctx.cdp.sendCommand('Accessibility.getFullAXTree') as { nodes: AXNode[] }
  return { url: ctx.guest.getURL(), title: ctx.guest.getTitle(), ...formatAxTree(nodes, opts) }
}

async function pointFor(ctx: ActionCtx, backendNodeId: number): Promise<{ x: number; y: number }> {
  await ctx.cdp.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
  const { quads } = await ctx.cdp.sendCommand('DOM.getContentQuads', { backendNodeId }) as { quads?: number[][] }
  const point = clickPointFromQuads(quads)
  // Never click the viewport origin for an element with no box (hidden,
  // display:none, detached): that would hit whatever sits top-left.
  if (!point) throw new Error('That element has no visible box (hidden or removed). Take a new browser_snapshot.')
  return point
}

/**
 * Trusted mouse input through CDP, not `element.click()`: real input respects
 * overlays and user-gesture rules (popups, file pickers, focus), which a
 * synthetic click skips.
 */
export async function clickAt(ctx: ActionCtx, x: number, y: number): Promise<void> {
  ctx.pointer(x, y)
  ctx.expectPointer(x, y)
  await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  ctx.checkEpoch()
  await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

export async function clickNode(ctx: ActionCtx, backendNodeId: number): Promise<void> {
  const { x, y } = await pointFor(ctx, backendNodeId)
  await clickAt(ctx, x, y)
}

/**
 * Keyboard input goes to THIS guest via focus emulation. Calling
 * webContents.focus() instead is what made T3 Code's agent steal the user's
 * chat focus (#10980/#11577) — and for a <webview> it does nothing anyway.
 */
async function emulateFocus(ctx: ActionCtx): Promise<void> {
  await ctx.cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
}

export async function typeInto(ctx: ActionCtx, backendNodeId: number, text: string, opts: { clear?: boolean; submit?: boolean }): Promise<void> {
  await emulateFocus(ctx)
  await ctx.cdp.sendCommand('DOM.focus', { backendNodeId })
  ctx.checkEpoch()
  ctx.expectKeys()
  if (opts.clear) {
    // Select-all + delete through real key events, so frameworks that listen
    // for input/keydown (React controlled inputs) see the change.
    const selectAll = process.platform === 'darwin' ? 4 : 2
    await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAll })
    await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAll })
    await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  if (text) await ctx.cdp.sendCommand('Input.insertText', { text })
  if (opts.submit) await pressKey(ctx, 'Enter', [])
}

const MODIFIER_BITS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const
const KEY_CODES: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Space: { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
}

export async function pressKey(ctx: ActionCtx, key: string, modifiers: Array<keyof typeof MODIFIER_BITS>): Promise<void> {
  await emulateFocus(ctx)
  ctx.checkEpoch()
  ctx.expectKeys()
  const bits = modifiers.reduce((acc, m) => acc | MODIFIER_BITS[m], 0)
  const known = KEY_CODES[key]
  const single = key.length === 1 ? { code: /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '', vk: key.toUpperCase().charCodeAt(0), text: key } : undefined
  const info = known ?? single
  if (!info) throw new Error(`Unknown key "${key}". Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`)
  // Text is only produced without Cmd/Ctrl/Alt (a Cmd+A must not type "a").
  const text = bits & (MODIFIER_BITS.Meta | MODIFIER_BITS.Ctrl | MODIFIER_BITS.Alt) ? undefined : info.text
  await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers: bits, ...(text ? { text } : {}) })
  await ctx.cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers: bits })
}

export async function scroll(ctx: ActionCtx, deltaX: number, deltaY: number, backendNodeId?: number): Promise<void> {
  const at = backendNodeId !== undefined ? await pointFor(ctx, backendNodeId) : await viewportCentre(ctx)
  ctx.checkEpoch()
  ctx.expectPointer(at.x, at.y)
  await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY })
}

async function viewportCentre(ctx: ActionCtx): Promise<{ x: number; y: number }> {
  const metrics = await ctx.cdp.sendCommand('Page.getLayoutMetrics').catch(() => null) as { cssVisualViewport?: { clientWidth: number; clientHeight: number } } | null
  const v = metrics?.cssVisualViewport
  return v ? { x: v.clientWidth / 2, y: v.clientHeight / 2 } : { x: 200, y: 200 }
}

export async function waitFor(ctx: ActionCtx, cond: { text?: string; urlIncludes?: string; gone?: string }, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  const expression = [
    cond.text ? `document.body?.innerText.includes(${JSON.stringify(cond.text)})` : 'true',
    cond.gone ? `!document.body?.innerText.includes(${JSON.stringify(cond.gone)})` : 'true',
  ].join(' && ')
  for (;;) {
    const urlOk = !cond.urlIncludes || ctx.guest.getURL().includes(cond.urlIncludes)
    const { result } = await ctx.cdp.sendCommand('Runtime.evaluate', { expression, returnByValue: true }).catch(() => ({ result: { value: false } })) as { result: { value?: unknown } }
    if (urlOk && result.value === true) return
    if (Date.now() >= until) throw new Error('The condition was not met in time.')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * JPEG, at most 1280 px wide: full-resolution PNGs in tool results broke T3
 * Code sessions (#11295). capturePage with a per-attempt deadline and retries,
 * because a cold guest can fail with UnknownVizError or never settle.
 */
export async function screenshot(ctx: ActionCtx, maxWidth = 1280): Promise<{ jpegBase64: string; width: number; height: number }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const image = await Promise.race([
        ctx.guest.capturePage(undefined, { stayHidden: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('capture timed out')), 1000)),
      ])
      if (image.isEmpty()) throw new Error('empty capture')
      const scaled = image.getSize().width > maxWidth ? image.resize({ width: maxWidth }) : image
      const size = scaled.getSize()
      return { jpegBase64: scaled.toJPEG(80).toString('base64'), ...size }
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
  throw new Error(`Screenshot failed (${lastError instanceof Error ? lastError.message : 'unknown'}); the page may not be rendering.`)
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
