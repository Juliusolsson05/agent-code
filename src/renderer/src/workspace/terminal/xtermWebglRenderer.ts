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
 * Is the GPU renderer allowed to attach at all?
 *
 * Currently NO, and this is the whole switch. Flip it back when the condition
 * in the next paragraph is met; everything else in this file is intact and
 * needs no other change.
 *
 * WHY: our pinned `@xterm/addon-webgl@0.19.0` corrupts its own texture atlas
 * under exactly the workload this app runs all day — a provider TUI streaming
 * heavy, colourful, constantly-redrawn output. Upstream xterm.js #5883 (merged
 * 2026-05-21) names the two bugs precisely: a fresh atlas page replacing an old
 * one AT THE SAME INDEX after a merge, which per-page version counters cannot
 * detect, and a stale vertex buffer after a mid-render merge because
 * `_requestClearModel` was set and never reset. The visible result is garbled
 * and interleaved glyphs, characters substituted mid-word, and leftover
 * inverse blocks that never repair because an idle terminal produces no further
 * frame.
 *
 * WHY the `invalidateTextureBindings` bridge below was not enough: it can
 * address the first bug's symptom from outside the addon. It cannot replicate
 * the second bug's fix, nor the bounded retry loop upstream added inside
 * `renderRows()` — both live below the addon's public surface. #789 shipped
 * that workaround and was closed without confirming the reporter's screenshot;
 * the corruption was reported again on 2026-09-08.
 *
 * WHY not simply upgrade, which is what the bridge's own comment anticipates:
 * the fix ships only in `@xterm/addon-webgl@0.20.0-beta.219` and later, there
 * is still no stable 0.20.0, and that beta's peer dependency is
 * `@xterm/xterm: ^6.1.0-beta.304`. Taking it would drag the CORE terminal —
 * the heart of every pane in the app — onto a beta as well. That is a much
 * larger surface than the one bug being fixed.
 *
 * WHY this costs less than it looks: the DOM renderer is xterm's default and
 * is correct, and it is already the tested fallback every failure path here
 * lands on. The perf work that introduced WebGL (#783, `3b885068`) had three
 * parts, and the two structural ones — routing raw PTY channels once per
 * renderer via sessionDataDispatcher, and coalescing inline grid resizes —
 * are untouched by this. VS Code ships the same escape hatch for the same
 * symptom class as `terminal.integrated.gpuAcceleration: "off"`.
 *
 * FLIP THIS BACK when `@xterm/addon-webgl` has a STABLE release containing
 * #5883 whose peer range accepts a stable `@xterm/xterm`. At that point also
 * delete the `invalidateTextureBindings` bridge above, which exists only to
 * paper over 0.19.0.
 */
const WEBGL_RENDERER_ENABLED = false

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
  // WHY the gate is a parameter rather than read straight from the constant:
  // this module's suite is the only record of how the attach, fallback,
  // context-loss and atlas-repair machinery behaves, and that machinery has to
  // keep working for the day the constant flips back. A hard-coded read would
  // have made all fifteen of those cases vacuous the moment WebGL went off.
  enabled: boolean = WEBGL_RENDERER_ENABLED,
): XtermWebglRenderer {
  // Bail before the dynamic import, so a disabled renderer costs nothing at
  // all: no addon parse, no GPU context, no atlas listeners. Callers keep
  // their existing shape and simply never see WebGL become active — the same
  // observable result as a machine where WebGL is unavailable by policy, which
  // this file already had to handle correctly.
  if (!enabled) {
    return { ready: Promise.resolve(false), dispose() {} }
  }

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
