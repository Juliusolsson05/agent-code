// Monaco model-count probe (#375 part A).
//
// WHY this indirection instead of the memory gauges importing monacoRuntime
// directly: monacoRuntime statically imports `monaco-editor` plus five
// `?worker` bundles. Putting that module on the import graph of
// useIpcSubscriptions (via the gauge emitter) would (a) drag the multi-MB
// Monaco chunk graph into the workspace hot path's transitive imports and
// (b) break every non-Vite consumer of the hook's graph — the renderer
// vitest project cannot resolve `monaco-editor`/`?worker` specifiers at all.
//
// So the dependency points the OTHER way: monacoRuntime registers a counter
// closure here once its lazy chunk actually loads, and the gauges read
// through it. A null probe means "Monaco was never loaded" — the gauge is
// simply skipped, which also guarantees instrumentation can never be the
// thing that forces the Monaco load.

let probe: (() => number) | null = null

/** Called by monacoRuntime.getMonaco() after the lazy import resolves. */
export function registerMonacoModelCountProbe(fn: () => number): void {
  probe = fn
}

/** Live Monaco text-model count, or null when Monaco has never loaded. */
export function monacoModelCount(): number | null {
  if (!probe) return null
  try {
    return probe()
  } catch {
    // A throwing probe must never take the gauge sweep down with it.
    return null
  }
}
