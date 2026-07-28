import type { ComponentType } from 'react'

import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

/**
 * One built-in app.
 *
 * WHY every field except `Component` is JSON-expressible: this shape is
 * deliberately the target that a future out-of-tree manifest resolves INTO. In
 * Stage 2 a loader reads `id`/`title`/`description`/`keywords` from
 * `agent-code.app.json` on disk and produces `Component` by importing the app's
 * bundle — everything else in `apps/` stays exactly as it is. Keeping this type a
 * strict superset-by-one of a manifest is what makes that a swap.
 *
 * The failure to avoid: adding a host-only field here — `getWorkspace: () =>
 * Workspace`, a store selector, a React context, anything not serializable. That
 * silently converts this from a manifest target into a host-only interface, and at
 * that moment Stage 1 becomes a substrate Stage 2 has to tear out rather than one
 * it keeps. If an app needs a capability, it belongs in `AgentCodeApiV1`, not here.
 */
export type AppDefinition = {
  /**
   * Stable id. Becomes the palette command id (`app.open.<id>`), the value held in
   * `openAppId`, and the on-disk state directory name under
   * `~/.config/agent-code/extensions/`. Renaming it orphans saved state and breaks
   * muscle memory — treat as permanent.
   *
   * Must satisfy the same pattern the main process enforces in
   * `main/extensions/storage.ts`: /^[a-z][a-z0-9-]{0,63}$/. A violation is not
   * caught here — it surfaces as an `InvalidAppIdError` on the first storage call,
   * which is deliberate: main owns that rule because main is where the id becomes
   * a filesystem path, and duplicating the check here would let the two drift.
   */
  id: string
  title: string
  /**
   * REQUIRED and non-empty: this string becomes the palette command's description,
   * and `buildCommandRegistry` throws on a blank description. A missing one is a
   * launch crash rather than a lint warning, so the type makes it non-optional.
   */
  description: string
  keywords?: string[]
  /**
   * The app's UI.
   *
   * WHY exactly one prop, unlike `SurfaceEntry.Component` which deliberately takes
   * none: for a first-party surface propless is right, because the surface can read
   * the store directly and props would put the host back in the wiring business.
   * For an app the opposite holds — the prop IS the boundary that makes the app
   * portable, and `api` is the only thing an app is permitted to depend on. An app
   * that imports anything from `@renderer/*` other than these two type modules has
   * broken the contract; the check is `grep -rn "@renderer/" src/renderer/src/apps/<id>/`.
   */
  Component: ComponentType<{ api: AgentCodeApiV1 }>
}
