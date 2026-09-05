import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type Disposable = { dispose(): void }

type WebglAddonLike = ITerminalAddon & {
  onContextLoss(handler: () => void): Disposable
  onAddTextureAtlasCanvas(handler: () => void): Disposable
  onRemoveTextureAtlasCanvas(handler: () => void): Disposable
  invalidateTextureBindings(): boolean
}

type WebglAddonModule = {
  WebglAddon: new () => WebglAddonLike
}

type TerminalAddonHost = Pick<Terminal, 'loadAddon' | 'refresh' | 'rows'>

export type XtermWebglRenderer = Disposable & {
  /** Resolves true only when WebGL became the active xterm renderer. */
  ready: Promise<boolean>
}

const loadWebglAddon = async (): Promise<WebglAddonModule> => {
  const { WebglAddon } = await import('@xterm/addon-webgl')
  return {
    WebglAddon: class extends WebglAddon {
      invalidateTextureBindings(): boolean {
        // WHY this one version-pinned private seam: 0.19.0 numbers texture
        // versions per page. When a merge moves a different page into the same
        // GPU slot, equal version numbers can suppress its texture upload.
        // Terminal.refresh repairs cell coordinates but NOT these stale pixels;
        // clearTextureAtlas destroys the shared glyph cache and still doesn't
        // reliably invalidate all bindings. Upstream fixes this with globally
        // unique versions (xterm.js #5883), unavailable in our stable addon.
        //
        // setAtlas with the *same* atlas invalidates only this renderer's GPU
        // bindings: no glyph eviction, theme/OSC palette reset, new GPU context,
        // terminal resize, or PTY work. Keep the private dependency HERE, shape
        // check it, and exercise it with the real Electron regression script.
        // Remove this bridge on upgrade to a stable addon containing #5883.
        const renderer = (this as unknown as {
          _renderer?: {
            _charAtlas?: object
            _glyphRenderer?: { value?: { setAtlas?: (atlas: object) => void } }
          }
        })._renderer
        const glyphs = renderer?._glyphRenderer?.value
        if (!renderer?._charAtlas || typeof glyphs?.setAtlas !== 'function') return false
        glyphs.setAtlas(renderer._charAtlas)
        return true
      }
    },
  }
}

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
  let atlasDisposables: Disposable[] = []
  let repaintPending = false

  // WHY atlas changes, not scroll/write events: our pinned WebGL 0.19.0 can
  // reorganize atlas pages *during* renderRows. Earlier cells in that same frame
  // retain the old texture coordinates. Its next frame rebuilds the model, but
  // an idle/scrolled terminal need not produce another frame, leaving garbled
  // glyphs on screen indefinitely (#789; upstream xterm.js #5883/#6038).
  //
  // Defer until the current render stack finishes, then let Terminal.refresh
  // schedule the repair through xterm's own frame coalescer. One merge removes
  // several pages and adds another; one microtask covers that whole burst.
  // Never clear the shared atlas or repaint on every scroll/output chunk: those
  // would repeatedly rasterize glyphs or duplicate the hot path we accelerated.
  // This event-driven workaround can go once a stable addon with the upstream
  // merge/retry fixes passes the colored-output/scroll regression workload.
  const scheduleAtlasRepaint = (): void => {
    const current = addon
    if (disposed || !current || repaintPending) return
    repaintPending = true
    queueMicrotask(() => {
      repaintPending = false
      // Context loss/unmount can happen before this runs. A stale GPU callback
      // must not touch a disposed terminal or refresh the replacement renderer.
      if (disposed || addon !== current) return
      try {
        if (!current.invalidateTextureBindings()) {
          disposeAddon()
          return
        }
        terminal.refresh(0, terminal.rows - 1)
      } catch {
        // An incompatible addon/GPU failure must leave a usable DOM terminal,
        // not throw asynchronously and strand the pane in a corrupt state.
        disposeAddon()
      }
    })
  }

  const disposeAddon = (): void => {
    const listener = contextLossDisposable
    const current = addon
    contextLossDisposable = null
    addon = null
    const atlasListeners = atlasDisposables
    atlasDisposables = []
    // Clear ownership before invoking third-party cleanup. A context-loss
    // callback can re-enter cleanup; it must never dispose the same addon twice.
    try { listener?.dispose() } catch { /* Keep host teardown progressing. */ }
    for (const atlasListener of atlasListeners) {
      try { atlasListener.dispose() } catch { /* One failed removal cannot leak the others. */ }
    }
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
        // Register separately: if the second registration throws, the first
        // subscription is already owned and gets cleaned up by the catch path.
        atlasDisposables.push(addon.onAddTextureAtlasCanvas(scheduleAtlasRepaint))
        atlasDisposables.push(addon.onRemoveTextureAtlasCanvas(scheduleAtlasRepaint))
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
