import type { TabId } from '../../tiles/types'

export type UiShellState = {
  commandPaletteOpen: boolean
  pathPickerOpen: boolean
  pathPickerDefault: string
  tileTabsModalOpen: boolean
  tileTabsInitialSelectedIds: TabId[]
  settingsPageOpen: boolean
  gitBarOpen: boolean
  debugPanelOpen: boolean
}
