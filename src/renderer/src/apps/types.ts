import type { ComponentType } from 'react'

import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

/**
 * One contributed extension view, resolved into something a host shell can render.
 *
 * WHY this type still exists after extensions moved into iframes: it is the seam
 * between "what a manifest declared" and "what a surface mounts". `derive.ts`
 * produces one of these per `contributes.views` entry, reading ONLY the manifest —
 * no bundle is imported to build it. AppHostSurface (modal) and ExtensionViewLeaf
 * (pane) both consume it, which is what lets the same view render in either shell
 * with nothing but the surrounding chrome differing.
 *
 * WHY every field except `Component` is JSON-expressible: they all come straight
 * off the manifest. `Component` is the one derived member, and it is a closure over
 * the iframe bridge rather than extension code — the extension itself never crosses
 * into this realm.
 *
 * The failure to avoid: adding a host-only field here — `getWorkspace: () =>
 * Workspace`, a store selector, a React context, anything not serializable. If a
 * view needs a capability it belongs in `AgentCodeApiV1`, brokered over
 * postMessage, not smuggled in beside the component.
 */
export type AppDefinition = {
  /**
   * The contributed view id, `<extensionId>.<view>`. Also the value held in
   * `openAppId` while the view is open as a modal.
   *
   * The extension-id half is what storage is namespaced by, so renaming it orphans
   * saved state — treat as permanent. The grammar is enforced by main, at install
   * (`main/extensions/manifest.ts`), because that is where a hostile manifest first
   * arrives and where the id becomes a filesystem path. It is deliberately NOT
   * re-checked here: a second copy of the rule is a second thing to drift.
   */
  id: string
  title: string
  /**
   * REQUIRED and non-empty: this string becomes the palette command's description,
   * and `buildCommandRegistry` throws on a blank description. A missing one is a
   * launch crash rather than a lint warning, so the type makes it non-optional.
   * `derive.ts` falls back to the extension's own description for this reason.
   */
  description: string
  keywords?: string[]
  /**
   * The view's host-side component: an iframe at the extension's origin, plus the
   * postMessage broker for it. Built by `viewComponentFor`.
   *
   * WHY exactly one prop, unlike `SurfaceEntry.Component` which deliberately takes
   * none: for a first-party surface propless is right, because the surface can read
   * the store directly. Here the prop IS the boundary — `api` is the only thing the
   * far side of the frame is permitted to depend on.
   */
  Component: ComponentType<{ api: AgentCodeApiV1 }>
}

/**
 * An extension whose frame could not start, surfaced on its Settings row.
 *
 * WHY failures are a VALUE in the store rather than a throw: an extension is
 * third-party code loaded at runtime. One that fails to import, exports no
 * `activate`, or throws inside it must leave every other extension running and must
 * never be able to blank the renderer.
 *
 * WHY this type lives here and not beside a host object: it used to be produced by
 * a host-realm `ExtensionHost` that imported and activated extension modules in the
 * renderer's own realm. That path is gone — an extension now runs only inside its
 * frame — so failures are REPORTED BY THE FRAME over postMessage and collected by
 * viewBridge. The type outlived its producer because the Settings row still needs
 * it; the producer is now the sandbox, which is the point.
 */
export type ExtensionFailure = {
  /** The extension id, matching `InstalledExtension.manifest.id`. */
  id: string
  /** Display name, so a row can be labelled before the manifest is looked up. */
  name: string
  /** The message shown under the extension's Settings row. */
  error: string
}
