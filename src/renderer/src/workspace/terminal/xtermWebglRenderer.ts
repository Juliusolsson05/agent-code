import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type Disposable = { dispose(): void }

// The addon surface this module depends on is deliberately just the public
// lifecycle: construct, activate (through terminal.loadAddon), dispose and
// onContextLoss. Under 0.19.0 it also subscribed to the texture-atlas events
// and reached into private renderer fields to force a rebind (the
// `invalidateTextureBindings` bridge, #789). That bridge was deleted with the
// move to the 0.20.0 beta line: the atlas bugs it papered over are fixed inside
// the addon there (xterm.js #5883), and a private-field seam against a
// continuously moving beta would have been a live hazard, not just dead code.
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

const loadWebglAddon = async (): Promise<WebglAddonModule> => {
  const { WebglAddon } = await import('@xterm/addon-webgl')
  return { WebglAddon }
}

/**
 * Is the GPU renderer allowed to attach at all?
 *
 * YES (#871). This constant is also the one-line ROLLBACK: if glyph corruption
 * ever reappears, set it to `false` and every xterm host falls back to xterm's
 * DOM renderer — correct, slower, and already the path every failure below
 * lands on. The off path stays tested (see the suite) for exactly that reason.
 *
 * History, because this switch has now flipped twice and the reasons matter:
 *
 * - 2026-09-04 (#783, `3b885068`): WebGL added. xterm 6's DOM renderer rebuilds
 *   every dirty row's spans on each repaint, and Claude Code repaints the whole
 *   viewport inside `?2026` synchronized-output brackets, so nearly every row is
 *   dirty on every frame — on every visible raw terminal (agent terminal view,
 *   plain shells, OpenCode Terminal), multiplied by visible lanes (#768).
 *
 * - 2026-09-08 (#841, `fcf70d0a`): turned OFF. The then-pinned
 *   `@xterm/addon-webgl@0.19.0` corrupts its own texture atlas under exactly
 *   that workload (#789): garbled and interleaved glyphs, characters replaced
 *   mid-word, inverse blocks that never repair because an idle terminal renders
 *   no further frame. Upstream xterm.js #5883 (merged 2026-05-21) fixes both
 *   causes — a fresh atlas page replacing an old one AT THE SAME INDEX after a
 *   merge (undetectable by per-page version counters), and a stale vertex
 *   buffer after a mid-render merge — but ships only on the 0.20.0 beta line,
 *   whose peer range requires a beta `@xterm/xterm`. The out-of-addon bridge
 *   could reach the first bug's symptom but not the second, nor upstream's
 *   bounded retry inside `renderRows()`.
 *
 * - 2026-09-11 (#871): turned back ON by pinning EXACTLY the line VS Code
 *   ships (`@xterm/xterm 6.1.0-beta.304`, `@xterm/addon-webgl 0.20.0-beta.300`,
 *   `@xterm/addon-fit 0.12.0-beta.301`). The only argument for staying off was
 *   "don't put the core terminal on a beta"; xterm.js publishes betas
 *   continuously from master and its largest consumer depends on these exact
 *   builds, which made waiting for a stable 0.20.0 cost more than it saved.
 *
 * Move to stable `@xterm/xterm 6.1.0` / `@xterm/addon-webgl 0.20.0` once they
 * publish, one deliberate PR. Keep the pins exact until then: a caret on a
 * prerelease floats to any newer beta of the same version on the next lockfile
 * refresh, which would let an unrelated `npm install` move the core terminal.
 */
const WEBGL_RENDERER_ENABLED = true

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
  // the constant is the rollback switch, and the suite must exercise BOTH
  // sides of it regardless of which way it currently points — the attach,
  // fallback and context-loss machinery for the on side, and the zero-cost
  // off path for the day corruption forces a rollback. A hard-coded read would
  // make whichever side is not current untestable.
  enabled: boolean = WEBGL_RENDERER_ENABLED,
): XtermWebglRenderer {
  // Bail before the dynamic import, so a disabled renderer costs nothing at
  // all: no addon parse, no GPU context, no listeners. Callers keep their
  // existing shape and simply never see WebGL become active — the same
  // observable result as a machine where WebGL is unavailable by policy, which
  // this file already had to handle correctly.
  if (!enabled) {
    return { ready: Promise.resolve(false), dispose() {} }
  }

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
