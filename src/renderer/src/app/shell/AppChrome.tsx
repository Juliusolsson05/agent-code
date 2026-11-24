import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { SettingsBar } from '@renderer/app/shell/SettingsBar'
import { RestoreBanner } from '@renderer/app/shell/RestoreBanner'
import { CliUpdateBanner } from '@renderer/features/cli-updates/CliUpdateBanner'
import { ConfigureDictationCard } from '@renderer/features/voice-dictation/ConfigureDictationCard'

// AppChrome — the window's top chrome: tab bar, settings bar, then the
// banner stack. Extracted from App.tsx so the ORDER of these rows is one
// small, testable unit (AppChrome.renderer.test.tsx pins it).
//
// THE INVARIANT: TabBar is the FIRST row of the window, always. Nothing
// that can appear or disappear at runtime may render above it.
//
// WHY that matters (macOS window chrome):
//   main builds the window with `titleBarStyle: 'hiddenInset'`
//   (main/window/appWindow.ts). There is no native title bar: the
//   red/yellow/green traffic lights are drawn OVER the top-left corner of
//   the web content, and the only way to move the window is to grab an
//   element styled `-webkit-app-region: drag`. TabBar is the row built for
//   that corner — it reserves an empty spacer exactly as wide as the
//   traffic lights (the inset main pushes over `traffic-light-inset`) and
//   it is a drag region, with `no-drag` opted back in per tab/button.
//
//   The banners (RestoreBanner, CliUpdateBanner, ConfigureDictationCard)
//   used to render ABOVE TabBar. Whenever one was visible it took the top
//   of the window: its text ran under the traffic lights (seen live: the
//   "CLI UPDATE Codex auto-update failed…" label sat under the buttons),
//   and since banners are not drag regions the window could no longer be
//   dragged by its top edge. It only worked when every banner was null.
//
// WHY move the banners below the chrome instead of making them a second
// title bar (inset spacer + drag region on the banner container):
//   - A drag region swallows mouse events. Banner text could no longer be
//     selected or copied — and the CLI failure text is exactly what users
//     paste into bug reports.
//   - Every button in every banner would need `no-drag`, and a banner
//     added later that forgets it gets dead buttons. With the banners
//     below TabBar, a new banner cannot break the window chrome at all.
//   - Each banner row would waste the traffic-light width on its left, and
//     the drag strip's height would change as banners come and go.
//   Below the chrome is also where browsers put the same kind of "this
//   run is degraded / an update needs you" infobar: under the toolbar,
//   above the page.
//
// WHY below SettingsBar and not between TabBar and SettingsBar: the two
// bars are one unit of chrome (SettingsBar is the second drag strip, and
// "compact row under tabs"). A banner wedged between them would split the
// chrome and push the settings controls around as it shows and hides.
//
// WHY a fragment and not a wrapper <div>: each row is a direct flex child
// of App's `h-screen flex flex-col` column with its own `flex-shrink-0`.
// A wrapper would change that layout for no gain.
//
// On Windows/Linux the native title bar still exists (hiddenInset is a
// macOS style, and main pushes no inset there), so this order changes
// nothing about window dragging there; the banners simply sit under the
// chrome on every platform, which keeps one layout to reason about.
export function AppChrome({
  workspace,
  onNewTabRequest,
}: {
  workspace: Workspace
  onNewTabRequest: () => void
}) {
  return (
    <>
      <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />
      <SettingsBar />
      {/* Workspace restore / save-failure state. RestoreBanner's header
          comment has the WHY of a persistent banner over a toast. */}
      <RestoreBanner />
      {/* CLI updater banner. Sits next to RestoreBanner because both
          surfaces communicate "durable degraded state for this run" — the
          exact use case RestoreBanner's header comment names. Renders as
          null when neither CLI has anything to report. */}
      <CliUpdateBanner />
      {/* Voice dictation configuration nudge — soft banner that
          disappears once a Deepgram key exists or the user dismisses
          it. Renders null unless the API key is unconfigured. */}
      <ConfigureDictationCard />
    </>
  )
}
