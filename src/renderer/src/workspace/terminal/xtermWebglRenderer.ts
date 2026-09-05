import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type Disposable = { dispose(): void }

type WebglAddonLike = ITerminalAddon & {
  onContextLoss(handler: () => void): Disposable
}

type WebglAddonModule = {
  WebglAddon: new () => WebglAddonLike
}

type TerminalAddonHost = Pick<Terminal, 'loadAddon'>

export type XtermWebglRenderer = Disposable & {
  /** Resolves true only when WebGL became the active xterm renderer. */
  ready: Promise<boolean>
}

const loadWebglAddon = (): Promise<WebglAddonModule> => import('@xterm/addon-webgl')

/**
 * Upgrade an already-open xterm from its DOM renderer to WebGL when available.
 *
 * WHY this is asynchronous: raw terminals are a secondary surface. Pulling the
 * WebGL renderer into the main renderer entry would make every feed-only window
 * pay its parse/startup cost even when it never opens xterm. The host calls this
 * immediately after `Terminal.open`, while the generation fence below makes a
 * late import harmless if React unmounts the pane first.
 *
 * WHY every failure falls back silently: WebGL can be unavailable by policy,
 * exhausted under memory pressure, or lost after sleep. The DOM renderer is
 * slower but correct. A GPU capability must never decide whether the user can
 * see or type into the provider terminal, and logging once per terminal would
 * itself become noise on a large workspace.
 */
export function attachXtermWebglRenderer(
  terminal: TerminalAddonHost,
  loadAddon: () => Promise<WebglAddonModule> = loadWebglAddon,
): XtermWebglRenderer {
  let disposed = false
  let addon: WebglAddonLike | null = null
  let contextLossDisposable: Disposable | null = null

  const disposeAddon = (): void => {
    const listener = contextLossDisposable
    const current = addon
    contextLossDisposable = null
    addon = null
    // Clear ownership before invoking third-party cleanup. A context-loss
    // callback can re-enter cleanup; it must never dispose the same addon twice.
    try { listener?.dispose() } catch { /* Keep host teardown progressing. */ }
    try { current?.dispose() } catch { /* GPU cleanup cannot strand the PTY host. */ }
  }

  const ready = Promise.resolve().then(loadAddon)
    .then(module => {
      if (disposed) return false

      try {
        addon = new module.WebglAddon()
        contextLossDisposable = addon.onContextLoss(() => {
          // The xterm project explicitly recommends disposing the addon on
          // context loss. Disposal hands rendering back to xterm's DOM path;
          // trying to recreate immediately can loop while the GPU process is
          // still under the same pressure that evicted the first context.
          disposeAddon()
        })
        terminal.loadAddon(addon)
        return addon !== null
      } catch {
        disposeAddon()
        return false
      }
    })
    .catch(() => false)

  return {
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      disposeAddon()
    },
  }
}
