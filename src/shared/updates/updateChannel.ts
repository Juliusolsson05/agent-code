/**
 * The in-app update channel (#1168, RELEASE.md "Channels").
 *
 * - `stable`: tested releases. The updater reads GitHub's `releases/latest`,
 *   which only ever names a manual stable release.
 * - `preview`: tonight's build of the next version. The updater reads the
 *   rolling `preview` release's `preview-mac.yml`, which
 *   .github/workflows/preview.yml publishes every night.
 *
 * Shared because main applies it and the Settings row names it.
 */
export const UPDATE_CHANNELS = ['stable', 'preview'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value)
}

/**
 * The channel before the user has chosen one: Stable, unless the running app
 * is itself a preview build.
 *
 * WHY a preview build defaults to Preview: someone who installed a preview by
 * hand wants previews. On Stable they would sit on `0.1.4-preview.<date>`
 * until 0.1.4 ships (the updater never downgrades and a stable feed offers
 * nothing newer), silently missing every nightly fix they installed a preview
 * to get.
 */
export function defaultUpdateChannel(appVersion: string): UpdateChannel {
  return /-preview\./.test(appVersion) ? 'preview' : 'stable'
}

// Mirrors the `publish` block of electron-builder.yml, which is what the
// packaged app's app-update.yml says. The Stable feed passes it explicitly
// because switching channels REPLACES the provider (setFeedURL), and there is
// no API to go back to "whatever app-update.yml said".
const OWNER = 'Juliusolsson05'
const REPO = 'agent-code'

/**
 * What electron-updater's `setFeedURL` receives for each channel.
 *
 * WHY the Preview channel uses the GENERIC provider on the rolling release,
 * and not the GitHub provider with prereleases on (the obvious alternative),
 * read in electron-updater 6.6:
 *   - `AppUpdater.channel`'s setter turns `allowDowngrade` on as a side effect
 *     and refuses to be cleared once set, so switching back to Stable within
 *     a session would be impossible.
 *   - The GitHub provider's prerelease mode walks the releases Atom feed. For
 *     a stable running version it takes the FIRST entry, which can be the
 *     rolling `preview` release (not a semver tag). With a channel it takes
 *     the newest matching tag in GitHub's feed order.
 *   - The rolling release always holds the newest preview, so a fixed URL
 *     needs no walk at all, and setFeedURL swaps providers without a restart.
 * The generic provider requests `<url>preview-mac.yml` (channel `preview`,
 * `-mac` added on macOS) and resolves the files that feed names against the
 * same URL, which is why the feed names the rolling copies.
 */
export type UpdateFeed =
  | { provider: 'generic'; url: string; channel: string }
  | { provider: 'github'; owner: string; repo: string }

export function updateFeedFor(channel: UpdateChannel): UpdateFeed {
  return channel === 'preview'
    ? { provider: 'generic', url: `https://github.com/${OWNER}/${REPO}/releases/download/preview/`, channel: 'preview' }
    : { provider: 'github', owner: OWNER, repo: REPO }
}
