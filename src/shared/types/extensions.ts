// Extension manifest and install-ledger shapes, shared by main and renderer.
//
// The manifest is authored by a third party and read off disk, so main validates it
// with zod (see main/extensions/manifest.ts) and the renderer only ever sees the
// validated result. These types are the contract between those two halves — the zod
// schema is the source of truth for VALIDATION, and this file is the source of truth
// for the SHAPE. If they drift, the schema wins and this file is the bug.

/** Where a contributed view is rendered. The host owns the chrome; an extension
 *  declares the KIND of surface it wants, not the pixels around it. Only 'modal'
 *  is implemented in v1 — the others are the same registration with a different
 *  host shell, and are reserved so a manifest written for them stays valid. */
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
}

/**
 * A power an extension can REQUEST beyond the always-granted Tier-0 API
 * (storage/ui/theme, which need no permission). A closed set: an unknown
 * capability fails validation at install, exactly as an unknown activation event
 * does, rather than being silently ignored.
 *
 * Tiered by blast radius (see the platform plan): Tier 1 is read-only metadata,
 * Tier 2 reads real user content, Tier 3 acts. Enforcement of Tiers 2-3 is only
 * meaningful once each extension runs in its own frame — which it now does — so the
 * grant a user gives at install (grants.ts) is what a capability check consults.
 */
export type ExtensionCapability =
  // Tier 1 — read-only metadata
  | 'workspace.observe'
  | 'sessions.observe'
  | 'panes.observe'
  // Tier 2 — reads the user's actual content
  | 'fs.read'
  | 'transcript.read'
  | 'git.read'
  // Tier 3 — acts
  | 'sessions.prompt'
  | 'fs.write'
  | 'git.commit'
  | 'network.fetch'

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  'workspace.observe',
  'sessions.observe',
  'panes.observe',
  'fs.read',
  'transcript.read',
  'git.read',
  'sessions.prompt',
  'fs.write',
  'git.commit',
  'network.fetch',
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
  /** `owner/repo` as the user typed it, normalized. */
  repo: string
  /** The git ref actually installed — a release tag when one exists, else the
   *  default branch name. Recorded so an update can report what it is moving from. */
  ref: string
  /** SHA-256 of the downloaded tarball. This is the integrity record: it is what a
   *  reinstall compares against, and what makes "which bytes am I running" an
   *  answerable question rather than a guess. */
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

export type ExtensionInstallResult =
  | { ok: true; entry: ExtensionListEntry }
  | { ok: false; error: string }
