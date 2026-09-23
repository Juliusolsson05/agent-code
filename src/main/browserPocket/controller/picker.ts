import type { PocketPickResult } from '@shared/browserPocket/types.js'

import { sizeFromBoxModel } from '../core/geometry.js'

import type { PocketInternals } from './BrowserPocketController.js'

/**
 * The user picks an element in the pocket (spec §4.7).
 *
 * WHY Chrome's own inspect mode (Overlay.setInspectMode) instead of a guest
 * preload: guests run with NO preload (guestGuard.ts), and CDP's overlay is
 * drawn by Chromium itself, so no page script can see, restyle or fake it.
 * The selector is built in an ISOLATED world for the same reason.
 */
export async function pickElement(
  p: PocketInternals,
  ensureAttached: () => void,
  registerAbort: (abort: (() => void) | null) => void,
): Promise<PocketPickResult | null> {
  ensureAttached()
  const cdp = p.guest.debugger
  await cdp.sendCommand('Overlay.enable')
  await cdp.sendCommand('Overlay.setInspectMode', {
    mode: 'searchForNode',
    highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.35 }, borderColor: { r: 111, g: 168, b: 220, a: 0.9 } },
  })
  const backendNodeId = await new Promise<number | null>(resolve => {
    let settled = false
    const onMessage = (_event: unknown, method: string, params: any) => {
      if (method === 'Overlay.inspectNodeRequested') done(params?.backendNodeId ?? null)
      if (method === 'Overlay.inspectModeCanceled') done(null)
    }
    const done = (value: number | null) => {
      if (settled) return
      settled = true
      registerAbort(null)
      clearTimeout(timer)
      // One listener per pick, removed here, so repeated picks do not pile up
      // handlers on the guest's debugger.
      cdp.removeListener?.('message', onMessage)
      resolve(value)
    }
    // Esc in the page, the chrome row's ◎ again, or 60 s of indecision.
    registerAbort(() => done(null))
    const timer = setTimeout(() => done(null), 60_000)
    cdp.on('message', onMessage)
  })
  await cdp.sendCommand('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {})
  if (!backendNodeId) return null

  // Resolve the node into an ISOLATED world: the selector function then runs
  // where page scripts cannot patch Element.prototype or the globals it reads.
  const { frameTree } = await cdp.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
  const { executionContextId } = await cdp.sendCommand('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'agent-code-pocket-picker' }) as { executionContextId: number }
  const { object } = await cdp.sendCommand('DOM.resolveNode', { backendNodeId, executionContextId }) as { object: { objectId: string } }
  const { result } = await cdp.sendCommand('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: SELECTOR_FUNCTION,
    returnByValue: true,
  }) as { result: { value: { path: Array<{ tag: string; id?: string; testId?: string; nth: number }>; role: string; name: string } } }
  const { model } = await cdp.sendCommand('DOM.getBoxModel', { backendNodeId }).catch(() => ({ model: undefined })) as { model?: { width: number; height: number; border: number[] } }
  const size = sizeFromBoxModel(model) ?? { width: 0, height: 0 }
  let image: string | null = null
  if (model?.border && size.width > 0 && size.height > 0) {
    const xs = [model.border[0]!, model.border[2]!, model.border[4]!, model.border[6]!]
    const ys = [model.border[1]!, model.border[3]!, model.border[5]!, model.border[7]!]
    const rect = { x: Math.max(0, Math.floor(Math.min(...xs))), y: Math.max(0, Math.floor(Math.min(...ys))), width: Math.ceil(size.width), height: Math.ceil(size.height) }
    try {
      const shot = await Promise.race([p.guest.capturePage(rect, { stayHidden: true }), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 1500))])
      if (!shot.isEmpty()) image = `data:image/jpeg;base64,${(shot.getSize().width > 800 ? shot.resize({ width: 800 }) : shot).toJPEG(80).toString('base64')}`
    } catch { /* the chip is still useful without a picture */ }
  }
  const v = result.value
  return { url: p.guest.getURL(), selector: buildSelector(v.path), role: v.role, name: v.name, width: size.width, height: size.height, image }
}

/**
 * id → data-testid → nth-of-type path, the order an engineer would search
 * the source by. Kept pure and exported for tests.
 */
export function buildSelector(path: Array<{ tag: string; id?: string; testId?: string; nth: number }>): string {
  const last = path[path.length - 1]
  if (!last) return ''
  if (last.id) return `#${cssIdent(last.id)}`
  const tested = [...path].reverse().find(step => step.testId)
  if (tested) return `[data-testid="${tested.testId!.replace(/"/g, '\\"')}"]`
  return path.map(step => `${step.tag}:nth-of-type(${step.nth})`).join(' > ')
}

/** Minimal CSS.escape for identifiers (Node has no CSS global). */
export function cssIdent(value: string): string {
  return value.replace(/^(\d)/, '\\3$1 ').replace(/([^\w-])/g, '\\$1')
}

// Runs in the page against the picked node. Kept as a string so it is shipped
// verbatim over CDP; it walks up to <body> recording tag, id, data-testid and
// position among same-tag siblings, plus role/name for the chip.
const SELECTOR_FUNCTION = `function () {
  const path = []
  let el = this.nodeType === 1 ? this : this.parentElement
  while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
    const tag = el.tagName.toLowerCase()
    let nth = 1
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) nth++
    path.unshift({ tag, id: el.id || undefined, testId: el.getAttribute('data-testid') || undefined, nth })
    if (tag === 'body') break
    el = el.parentElement
  }
  const target = this.nodeType === 1 ? this : this.parentElement
  const role = (target && (target.getAttribute('role') || target.tagName.toLowerCase())) || ''
  const name = (target && (target.getAttribute('aria-label') || target.innerText || target.getAttribute('title') || target.getAttribute('alt') || '')) || ''
  return { path: path.slice(-8), role, name: String(name).slice(0, 200) }
}`
