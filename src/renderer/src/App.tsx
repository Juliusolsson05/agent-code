import { useCallback, useState } from 'react'

import { ThemePicker } from './feed/ThemePicker'
import { TabBar } from './tiles/TabBar'
import { TileTree } from './tiles/TileTree'
import { useKeybinds } from './tiles/useKeybinds'
import { useWorkspace } from './tiles/workspaceStore'
import { applyTheme, loadSettings, type Settings } from './themes'

// App — thin shell around the workspace hook.
//
// Responsibilities:
//   1. Apply the persisted theme before first render (no FOUC).
//   2. Instantiate the workspace hook (owns all tab/pane state + IPC).
//   3. Register global keybinds.
//   4. Render the tab bar on top and the active tab's tile tree below.
//   5. Wire the "new tab" flow (pickDirectory → newTab).
//
// Everything else — session spawning, per-pane input, feed rendering,
// streaming preview, trust modal — lives inside TileLeaf or the store.
// This file stays short on purpose.

applyTheme(loadSettings())

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings())
  const [pathPickerOpen, setPathPickerOpen] = useState(false)
  const [pathPickerDefault, setPathPickerDefault] = useState('')
  const workspace = useWorkspace()

  // Pre-fill the path input with a sensible default when the modal
  // opens: the cwd of the most recently-used session, or main's
  // default cwd if no sessions exist yet. Cached so opening the modal
  // doesn't hit IPC every time.
  useEffect(() => {
    if (!pathPickerOpen) return
    const mostRecent = Object.values(workspace.state.sessions).pop()
    if (mostRecent?.cwd) {
      setPathPickerDefault(mostRecent.cwd)
      return
    }
    void window.api.defaultCwd().then(setPathPickerDefault)
  }, [pathPickerOpen, workspace.state.sessions])

  // New tab flow: show the path modal. On accept it calls workspace.newTab
  // with the expanded absolute path and closes the modal.
  const onNewTabRequest = useCallback(() => {
    setPathPickerOpen(true)
  }, [])

  const onPathPickerAccept = useCallback(
    async (cwd: string) => {
      await workspace.newTab(cwd)
      setPathPickerOpen(false)
    },
    [workspace],
  )

  useKeybinds(workspace, onNewTabRequest)

  const { state, activeTab } = workspace

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
      {/* Tab bar */}
      <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />

      {/* Settings bar — compact row under tabs holding app chrome. */}
      <div
        className="
          flex items-center justify-end gap-3
          px-3 py-1.5
          border-b border-border bg-surface
          flex-shrink-0
          [-webkit-app-region:drag]
        "
      >
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <ThemePicker settings={settings} onChange={setSettings} />
        </div>
      </div>

      {/* Active tab's tile tree, or a welcome screen if the workspace
          is entirely empty (first launch, or user closed every tab). */}
      <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {activeTab ? (
          <TileTree
            node={activeTab.root}
            focusedSessionId={activeTab.focusedSessionId}
            workspace={workspace}
          />
        ) : state.tabs.length === 0 ? (
          <WelcomeEmpty onNewTabRequest={onNewTabRequest} />
        ) : null}
      </main>

      <PathPickerModal
        open={pathPickerOpen}
        defaultValue={pathPickerDefault}
        onCancel={() => setPathPickerOpen(false)}
        onAccept={onPathPickerAccept}
      />
    </div>
  )
}

// Shown when there are zero tabs — either first launch before the
// default session spawns, or the user closed everything.
function WelcomeEmpty({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="text-muted text-[12px]">no tabs open</div>
        <button
          type="button"
          onClick={onNewTabRequest}
          className="
            px-4 py-2 text-[12px]
            bg-accent text-accent-fg
            border border-accent
            hover:brightness-110
            transition-all duration-120
          "
        >
          new tab (⌘T)
        </button>
      </div>
    </div>
  )
}
