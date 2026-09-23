import type { Browser, Page } from 'playwright-core'
import type { ActionCtx, GuestLike } from './BrowserPocketController.js'
import { PocketPlaywrightTransport } from './playwrightTransport.js'

type Connection = { transport: PocketPlaywrightTransport; page: Promise<Page> }
const connections = new WeakMap<GuestLike, Connection>()

/** Reuse Playwright's connection while the native guest lives. The controller
 * serializes calls for each pocket; there must be only one active ActionCtx
 * on this transport. A debugger detach closes this connection immediately,
 * so a timeout/reload cannot accidentally keep driving the old document. */
export async function withPocketPage<T>(ctx: ActionCtx, action: (page: Page) => Promise<T>): Promise<T> {
  let connection = connections.get(ctx.guest)
  if (!connection || connection.transport.closed) {
    // Use Chromium's actual target id: Playwright correlates it with frame
    // events. An invented id looks plausible but breaks main-frame tracking.
    const { targetInfo } = await ctx.cdp.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } }
    ctx.checkEpoch()
    const transport = new PocketPlaywrightTransport(ctx.guest, process.versions.chrome ?? '149.0.0.0', targetInfo.targetId)
    transport.setAction(ctx)
    const page = connect(transport)
    connection = { transport, page }
    connections.set(ctx.guest, connection)
  }
  const { transport, page } = connection
  transport.setAction(ctx)
  let livePage: Page | undefined
  try {
    livePage = await page
    ctx.checkEpoch()
    return await action(livePage)
  } catch (error) {
    // Map a library AbortError back to the controller's structured takeover
    // result; agents must stop instead of treating it as a transient failure.
    ctx.signal.throwIfAborted()
    throw error
  } finally {
    try {
      if (livePage && !transport.closed) await transport.releaseInputs(livePage)
    } catch {
      // A dead protocol session must not be reused with unknown held-input
      // state. The controller deadline still bounds unresponsive cleanup.
      transport.close()
    } finally { transport.setAction(null) }
  }
}

async function connect(transport: PocketPlaywrightTransport): Promise<Page> {
  try {
    // playwright-core brings no browser download. Electron supplies Chromium;
    // lazy import keeps unused pockets free of automation startup cost.
    const { chromium } = await import('playwright-core')
    const browser: Browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 10_000 })
    const page = browser.contexts()[0]?.pages()[0]
    if (!page) throw new Error('Embedded browser page was not attached')
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(14_000)
    return page
  } catch (error) { transport.close(); throw error }
}
