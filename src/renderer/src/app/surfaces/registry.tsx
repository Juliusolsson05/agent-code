import type { SurfaceEntry } from './types'
import { CaffeinateToastSurface } from '@renderer/features/caffeinate/surfaces/CaffeinateToastSurface'
import { PathPickerSurface } from '@renderer/features/path-picker/surfaces/PathPickerSurface'
import { TileTabsModalSurface } from '@renderer/features/workspace/surfaces/TileTabsModalSurface'
import { ReorderTabsSurface } from '@renderer/features/workspace/surfaces/ReorderTabsSurface'
import { PinAgentsSurface } from '@renderer/features/dispatch-pin/surfaces/PinAgentsSurface'
import { BuryPanePromptSurface } from '@renderer/features/workspace/surfaces/BuryPanePromptSurface'
import { ViewPromptsSurface } from '@renderer/features/workspace/surfaces/ViewPromptsSurface'
import { PromptSearchSurface } from '@renderer/features/workspace/surfaces/PromptSearchSurface'
import { AgentActivitySurface } from '@renderer/features/workspace/surfaces/AgentActivitySurface'
import { CloseOldAgentsSurface } from '@renderer/features/workspace/surfaces/CloseOldAgentsSurface'
import { BulkProviderSwitchSurface } from '@renderer/features/workspace/surfaces/BulkProviderSwitchSurface'
import { AgentViewModePickerSurface } from '@renderer/features/workspace/surfaces/AgentViewModePickerSurface'
import { RewindToPromptSurface } from '@renderer/features/workspace/surfaces/RewindToPromptSurface'

// The surface registry (issue #494). Adding a surface = write a wrapper
// in the owning feature's surfaces/ folder + add ONE import + ONE array
// entry here. App.tsx is never edited.
//
// ORDER MATTERS within each array: it is the DOM sibling order, which
// decides paint order when z-indexes tie. The order below is the exact
// order App.tsx rendered these surfaces before the extraction — keep new
// entries at the END unless you have a stacking reason and write it down.

/** Rendered at the app root, after the overlays. */
export const modalSurfaces: SurfaceEntry[] = [
  { id: 'path-picker', Component: PathPickerSurface },
  { id: 'tile-tabs', Component: TileTabsModalSurface },
  { id: 'reorder-tabs', Component: ReorderTabsSurface },
  { id: 'pin-agents', Component: PinAgentsSurface },
  { id: 'bury-pane', Component: BuryPanePromptSurface },
  { id: 'view-prompts', Component: ViewPromptsSurface },
  { id: 'prompt-search', Component: PromptSearchSurface },
  { id: 'agent-activity', Component: AgentActivitySurface },
  { id: 'close-old-agents', Component: CloseOldAgentsSurface },
  { id: 'bulk-provider-switch', Component: BulkProviderSwitchSurface },
  { id: 'agent-view-mode-picker', Component: AgentViewModePickerSurface },
  { id: 'rewind-to-prompt', Component: RewindToPromptSurface },
]

/** Rendered at the app root, after the main row, before the modals. */
export const overlaySurfaces: SurfaceEntry[] = [
  { id: 'caffeinate-toast', Component: CaffeinateToastSurface },
]

/** Rendered INSIDE the main flex row, as siblings after <main>. */
export const sidePanelSurfaces: SurfaceEntry[] = []
