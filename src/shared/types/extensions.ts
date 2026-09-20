import type { ExtensionThemeContribution } from './extensionThemes.js'

// Extension manifest and install-ledger shapes, shared by main and renderer.
//
// The manifest is authored by a third party and read off disk, so main validates it
// with zod (see main/extensions/manifest.ts) and the renderer only ever sees the
// validated result. These types are the contract between those two halves — the zod
// schema is the source of truth for VALIDATION, and this file is the source of truth
// for the SHAPE. If they drift, the schema wins and this file is the bug.

/** Where a contributed view is rendered. The host owns the chrome; an extension
 *  declares the kind of surface it wants, not the pixels around it. Both modal
 *  and panel hosts support the legacy and managed-runtime view adapters. */
export type ExtensionViewMount = 'modal' | 'panel'

export type ExtensionCommandContribution = {
  /** Must be namespaced `<extensionId>.` — enforced at install. */
  id: string
  title: string
  description?: string
  keywords?: string[]
}

export type ExtensionViewContribution = {
  id: string
  title: string
  mount: ExtensionViewMount
  /** Required in API v2: a separate module exporting mount(element, context). */
  entry?: string
}

export type ExtensionSettingContribution =
  | { id: string; title: string; description?: string; type: 'boolean'; default: boolean }
  | { id: string; title: string; description?: string; type: 'number'; default: number }
  | { id: string; title: string; description?: string; type: 'string'; default: string }

export type ExtensionKeybindingContribution = {
  /** A command id this manifest also contributes. */
  command: string
  /** Accelerator, e.g. `cmd+shift+t`. Consulted AFTER every first-party
   *  binding, so an extension can never shadow ⌘W. */
  key: string
}

export type ExtensionContributions = {
  commands?: ExtensionCommandContribution[]
  views?: ExtensionViewContribution[]
  settings?: ExtensionSettingContribution[]
  keybindings?: ExtensionKeybindingContribution[]
  themes?: ExtensionThemeContribution[]
}

/**
 * A power an extension can REQUEST beyond the always-granted Tier-0 API
 * (storage/ui/theme, which need no permission). A closed set: an unknown
 * capability fails validation at install, exactly as an unknown activation event
 * does, rather than being silently ignored.
 *
 * ── THIS LIST CONTAINS ONLY CAPABILITIES THAT ARE IMPLEMENTED ──
 * It previously declared Tier 2/3 names before any of them existed. There was no
 * request method for any of them in
 * frameProtocol, no arm in frameHost.perform, and no API surface an extension
 * could call — `network.fetch` was additionally impossible by construction,
 * since the child CSP is `connect-src <self>` only.
 *
 * What that produced was consent theatre: a manifest could request "filesystem
 * write and git commit", the user got a blocking OS warning dialog naming those
 * powers, approved it, and a permanent grant was written for capabilities that
 * did nothing. The cost is not the dead code — it is that it trains people to
 * click through the one dialog in the product that must not become routine.
 *
 * So the rule for this union is: **a capability is added here in the same change
 * that implements it**, i.e. together with its member of `frameRequestSchema`,
 * its entry in frameHost's REQUIRED_CAPABILITY record (which will not compile
 * without one), and its arm in `perform`. Declaring the vocabulary ahead of the
 * mechanism is what went wrong; the tier names below are a design note about
 * blast radius, not a roadmap that manifests may write against.
 *
 * Tier 1 is read-only metadata. Scoped files and background notifications are
 * the first services restored under this rule. Other Tier 2/3 powers remain
 * unrepresentable until their transports and target authority exist — a
 * manifest asking for one fails install with a message naming it, which is
 * actionable, rather than being granted nothing in silence.
 */
export type ExtensionCapability =
  // Tier 1 — read-only metadata. Implemented: frameProtocol has a request
  // member for each, frameHost gates each on this grant, createAppHostApi
  // returns a curated serializable snapshot.
  | 'workspace.observe'
  | 'sessions.observe'
  | 'panes.observe'
  // Tier 2/3 — real project contents. Implemented for API v2 through the
  // main-owned service broker; every call names a live session target whose
  // canonical cwd is the filesystem authority.
  | 'fs.read'
  | 'fs.write'
  // A background runtime has no visible view whose Tier-0 ui.showToast it can
  // borrow. This explicit grant is the narrow channel used by timers and other
  // requested background work to report a short status to application windows.
  | 'notifications.show'

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  'workspace.observe',
  'sessions.observe',
  'panes.observe',
  'fs.read',
  'fs.write',
  'notifications.show',
]

/**
 * When the host imports and activates an extension's module.
 *
 * The whole reason contributions are DECLARED rather than registered by running
 * the extension: the palette and Settings can list everything an extension
 * offers while its module has never been loaded, so activation can be deferred
 * to first use. Without declarations, populating a command list would require
 * importing every installed extension at startup.
 */
export type ExtensionActivationEvent =
  | 'onStartupFinished'
  | '*'
  | `onCommand:${string}`
  | `onView:${string}`

/** Contents of `agent-code.extension.json` at the root of an extension repository. */
export type ExtensionManifest = {
  /** Stable identity. Also the install directory name and the storage namespace,
   *  so it is constrained to /^[a-z][a-z0-9-]{0,63}$/ — see manifest.ts. */
  id: string
  name: string
  description: string
  /** Author's own version string. Displayed and recorded; not interpreted. */
  version: string
  /** Which AgentCodeApi major this extension was written against. The host refuses
   *  to load a manifest whose apiVersion it does not implement, which is the whole
   *  point of versioning the ABI rather than silently passing a newer host object
   *  to an extension written for an older one. */
  apiVersion: number
  /** Path, relative to the repository root, of the built ES module to load.
   *  Must stay inside the bundle — validated, not trusted. */
  entry: string
  keywords?: string[]
  /** Absent means "never activate" — legal, and how a manifest that only
   *  contributes settings behaves. */
  activationEvents?: ExtensionActivationEvent[]
  contributes?: ExtensionContributions
  /** Capabilities beyond Tier 0 this extension requests. The user grants (or
   *  declines) them at install; absent/empty means Tier 0 only. */
  permissions?: ExtensionCapability[]
}

/** One row in the install ledger (`extensions.json`). */
export type InstalledExtension = {
  manifest: ExtensionManifest
  /** New installs publish these together with the manifest in one atomic ledger
   *  write. The generation is an immutable bundle directory; its hash covers all
   *  served files. Manifest permissions are the approved grant for those bytes.
   *  Absence identifies a legacy install using the separate grants file. */
  installation?: { id: string; bundleSha256: string }
  /**
   * Where this extension came from, in a form the installer can re-run.
   *
   * WHY `origin` exists rather than sniffing `repo`: a GitHub install stores
   * `owner/repo` here, and a local-folder install stores an ABSOLUTE PATH. Update
   * fed this field straight back to `installExtension`, which calls
   * `normalizeRepo` — so every Update of a locally-loaded extension failed with
   * `"/Users/…/timer" is not a GitHub repository`, which is the one install path an
   * author uses on every single rebuild. Making the origin explicit lets Update
   * dispatch instead of guessing from the string's shape.
   */
  origin: 'github' | 'local'
  /** `owner/repo` for a GitHub install; the absolute source folder for a local one. */
  repo: string
  /** The git ref actually installed — a release tag when one exists, else the
   *  default branch name. Recorded so an update can report what it is moving from. */
  ref: string
  /** SHA-256 of the downloaded tarball (or, for a local-folder install, of the
   *  built entry file — there is no tarball). This is PROVENANCE and nothing
   *  else: it answers "which bytes did the source hand me", and it is what an
   *  update reports moving from.
   *
   *  This provenance hash never authorizes capabilities. New installations bind
   *  approval to installation.bundleSha256, checked against bytes freshly hashed
   *  from disk; legacy installations use the separate grant store. Comparing two
   *  stored copies of a hash would not detect a modified bundle. */
  sha256: string
  /** Epoch millis. */
  installedAt: number
}

/** What the Settings UI renders for each installed extension. */
export type ExtensionListEntry = InstalledExtension & {
  /** False when the ledger has a row but the bundle directory is missing or its
   *  entry file is absent — a half-removed or hand-deleted install. Surfaced rather
   *  than hidden so the user can see why an extension stopped appearing. */
  present: boolean
}

/** Runtime identity is a committed generation, never just the entry-file hash.
 *  The fallback lets pre-generation installations keep loading until updated. */
export function extensionRevision(entry: InstalledExtension): string {
  return entry.installation?.id ?? `${entry.manifest.version}-${entry.sha256.slice(0, 12)}`
}

export type ExtensionInstallResult =
  | { ok: true; entry: ExtensionListEntry }
  | { ok: false; error: string }
