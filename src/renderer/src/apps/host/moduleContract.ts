import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

// WHY this lives under renderer/apps/host/ and NOT in src/shared/types/:
// it references AgentCodeApiV1, which is renderer code, and src/shared is
// compiled by the node tsconfig project which cannot see @renderer/*. That is a
// real boundary, not a build quirk — main validates MANIFESTS (shared types) and
// never touches an extension module, because modules are imported into the
// renderer realm. Putting this in shared compiled fine right up until tsc
// noticed the cross-project import, and moving it is the correct fix rather than
// widening the node project's file list.

export type Disposable = { dispose(): void }

/**
 * A view's renderer: DOM element in, cleanup function out.
 *
 * WHY DOM-level rather than a React component: it keeps React optional (plain
 * DOM, Preact, Svelte and canvas all work with no framework negotiation), and it
 * is the one shape that survives a future move into an iframe. A React component
 * reference cannot cross a frame boundary; "call mount with this element" can be
 * reimplemented on the far side unchanged. A React author writes
 * `createRoot(element).render(<App/>)` on one line.
 */
export type ViewMount = (element: HTMLElement) => void | (() => void)

/**
 * What `activate()` receives.
 *
 * WHY registration is separate from declaration: the manifest declares WHAT
 * exists so the palette and Settings can list it without loading anything; this
 * binds the HANDLERS once the module is finally imported. An id that was never
 * declared is rejected here rather than silently accepted, because a handler the
 * palette has no entry for can never be invoked and the author would have no
 * way to notice.
 */
export type ExtensionContext = {
  readonly api: AgentCodeApiV1
  registerCommand(id: string, run: () => void | Promise<void>): Disposable
  registerView(id: string, mount: ViewMount): Disposable
  /** Disposed in reverse order on deactivate. */
  readonly subscriptions: Disposable[]
}

export type ExtensionModule = {
  activate(context: ExtensionContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
