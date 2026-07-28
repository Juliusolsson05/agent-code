import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'

/** The shape an extension bundle's shims read. Changing it is an ABI break. */
export type AgentCodeHostGlobal = {
  react: typeof React
  reactDom: typeof ReactDOM
  jsxRuntime: typeof ReactJsxRuntime
  apiVersion: 1
}

const GLOBAL_KEY = '__agentCodeHost'

/**
 * Publish the host runtime for extension bundles to bind against.
 *
 * WHY this exists at all: an extension that renders React cannot bundle its own
 * copy — two React instances in one document means two reconcilers, and every
 * hook throws "invalid hook call". It also cannot import the host's copy by
 * specifier, because the app's chunks are content-hashed (`index-BV5jdlWA.js`)
 * and rotate on every build, so there is no stable URL to import from.
 *
 * WHY a global rather than a field on AgentCodeApiV1: putting React on the
 * extension API would version the host's React major INTO the extension ABI — a
 * React 19 upgrade would become a breaking change for every extension, including
 * the ones that never used React. The API stays framework-free; the runtime is a
 * separate, lower-level handshake.
 *
 * WHY a global rather than an import map: an import map must be declared before
 * the document's first module loads and must resolve `react` to a URL — which
 * would have to be a shim that reads a global anyway. Same mechanism, extra
 * indirection, plus a load-order constraint. The extension's own build aliases
 * `react` to a shim that reads this object, so no bare specifier ever reaches the
 * browser.
 *
 * WHY frozen and non-configurable: this object is reachable from all renderer
 * code, so locking it removes the trivial footgun of one extension swapping the
 * host's React out from under every other consumer. It is NOT a security
 * boundary — a same-realm extension can reach `window.api` directly, and only
 * moving extensions into a frame changes that. The freeze is about accidents,
 * not attacks, and the distinction is worth keeping honest.
 */
export function installHostGlobal(): void {
  const globals = globalThis as Record<string, unknown>
  // Idempotent: React StrictMode and HMR can both re-run module init, and
  // defineProperty on an existing non-configurable key throws.
  if (Object.prototype.hasOwnProperty.call(globals, GLOBAL_KEY)) return

  const host: AgentCodeHostGlobal = Object.freeze({
    react: React,
    reactDom: ReactDOM,
    jsxRuntime: ReactJsxRuntime,
    apiVersion: 1,
  })

  Object.defineProperty(globals, GLOBAL_KEY, {
    value: host,
    writable: false,
    configurable: false,
    // Non-enumerable so it does not show up in devtools' global listing or in
    // anything that walks globalThis. Extensions know the key by name.
    enumerable: false,
  })
}
