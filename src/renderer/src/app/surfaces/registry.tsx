import type { SurfaceEntry } from './types'
import { CaffeinateToastSurface } from '@renderer/features/caffeinate/surfaces/CaffeinateToastSurface'
import { VoiceDictationSurface } from '@renderer/features/voice-dictation/surfaces/VoiceDictationSurface'
import { TiledDispatchCountSurface } from '@renderer/features/workspace/surfaces/TiledDispatchCountSurface'
import { DebugBundleNoteSurface } from '@renderer/features/debug/surfaces/DebugBundleNoteSurface'
import { RecordingNoteSurface } from '@renderer/features/debug/surfaces/RecordingNoteSurface'
import { UsageModalSurface } from '@renderer/features/usage/surfaces/UsageModalSurface'
import { GitBarSurface } from '@renderer/features/git/surfaces/GitBarSurface'
import { WorktreesBarSurface } from '@renderer/features/worktrees/surfaces/WorktreesBarSurface'
import { AgentStatusPanelSurface } from '@renderer/features/agent-status/surfaces/AgentStatusPanelSurface'
import { RemotePanelSurface } from '@renderer/features/remote/surfaces/RemotePanelSurface'
import { DebugSurfaces } from '@renderer/features/debug/surfaces/DebugSurfaces'
import { CommandPaletteSurface } from '@renderer/features/command-palette/surfaces/CommandPaletteSurface'
import { PathPickerSurface } from '@renderer/features/path-picker/surfaces/PathPickerSurface'
import { TileTabsModalSurface } from '@renderer/features/workspace/surfaces/TileTabsModalSurface'
import { ReorderTabsSurface } from '@renderer/features/workspace/surfaces/ReorderTabsSurface'
import { PinAgentsSurface } from '@renderer/features/dispatch-pin/surfaces/PinAgentsSurface'
import { BuryPanePromptSurface } from '@renderer/features/workspace/surfaces/BuryPanePromptSurface'
import { CloseConfirmationSurface } from '@renderer/features/workspace/surfaces/CloseConfirmationSurface'
import { ViewPromptsSurface } from '@renderer/features/workspace/surfaces/ViewPromptsSurface'
import { PromptSearchSurface } from '@renderer/features/workspace/surfaces/PromptSearchSurface'
import { AgentActivitySurface } from '@renderer/features/workspace/surfaces/AgentActivitySurface'
import { CloseOldAgentsSurface } from '@renderer/features/workspace/surfaces/CloseOldAgentsSurface'
import { BulkProviderSwitchSurface } from '@renderer/features/workspace/surfaces/BulkProviderSwitchSurface'
import { AgentViewModePickerSurface } from '@renderer/features/workspace/surfaces/AgentViewModePickerSurface'
import { ColorFlagPickerSurface } from '@renderer/features/workspace/surfaces/ColorFlagPickerSurface'
import { KeyboardShortcutsSurface } from '@renderer/features/settings/surfaces/KeyboardShortcutsSurface'
import { RewindToPromptSurface } from '@renderer/features/workspace/surfaces/RewindToPromptSurface'

// The surface registry (issue #494). Adding a surface = write a wrapper
// in the owning feature's surfaces/ folder + add ONE import + ONE array
// entry here. App.tsx is never edited.
//
// ORDER MATTERS within each array, AND the mount order of the groups in
// App.tsx (overlays → modals) is part of the same contract: together they
// define the DOM sibling order at the app root, which IS the paint order
// whenever z-indexes tie. Most of these surfaces are `position: fixed`
// z-50, so "which array, at which index" decides what covers what. The
// order below is the exact order App.tsx rendered these surfaces before
// the extraction — keep new entries at the END unless you have a stacking
// reason and write it down.

/** Rendered at the app root, after the overlays. */
export const modalSurfaces: SurfaceEntry[] = [
  { id: 'command-palette', Component: CommandPaletteSurface },
  { id: 'path-picker', Component: PathPickerSurface },
  // ⚠ Two non-modal surfaces interleaved into the modal stack ON PURPOSE.
  // Pre-refactor App.tsx rendered them exactly here — after the palette
  // and path picker, before the tile-tabs..usage modals — and that DOM
  // position is load-bearing because all three of palette / dispatch-count
  // / toast are fixed z-50, so sibling order is the only tiebreaker:
  //   - tiled-dispatch-count must paint ABOVE the command palette. Tiled
  //     dispatch can fire while the palette is open (native menu; the
  //     palette deliberately stays open for keepPaletteOpen-style flows),
  //     and the count prompt is the thing awaiting input — burying it
  //     behind the palette soft-locks the flow.
  //   - both must stay BELOW the later modals (a modal opened over the
  //     toast dims it, as before).
  // The first cut of this registry put these two in overlaySurfaces
  // (rendered before the modals group), which silently reversed the
  // palette/count-prompt stacking — codex review of PR #505 caught it.
  // Grouping by semantic kind is NOT safe here; group by paint order.
  { id: 'tiled-dispatch-count', Component: TiledDispatchCountSurface },
  { id: 'caffeinate-toast', Component: CaffeinateToastSurface },
  { id: 'keyboard-shortcuts', Component: KeyboardShortcutsSurface },
  { id: 'tile-tabs', Component: TileTabsModalSurface },
  { id: 'reorder-tabs', Component: ReorderTabsSurface },
  { id: 'pin-agents', Component: PinAgentsSurface },
  { id: 'bury-pane', Component: BuryPanePromptSurface },
  { id: 'close-confirmation', Component: CloseConfirmationSurface },
  { id: 'debug-bundle-note', Component: DebugBundleNoteSurface },
  { id: 'recording-note', Component: RecordingNoteSurface },
  { id: 'view-prompts', Component: ViewPromptsSurface },
  { id: 'prompt-search', Component: PromptSearchSurface },
  { id: 'agent-activity', Component: AgentActivitySurface },
  { id: 'close-old-agents', Component: CloseOldAgentsSurface },
  { id: 'bulk-provider-switch', Component: BulkProviderSwitchSurface },
  { id: 'agent-view-mode-picker', Component: AgentViewModePickerSurface },
  { id: 'color-flag-picker', Component: ColorFlagPickerSurface },
  { id: 'rewind-to-prompt', Component: RewindToPromptSurface },
  { id: 'usage', Component: UsageModalSurface },
]

/**
 * Rendered at the app root, after the main row, BEFORE the modals — so
 * everything in this array paints UNDER the modal stack when z-indexes
 * tie. Only surfaces that must never cover a modal belong here (voice
 * dictation is z-40, below the z-50 stack regardless). A z-50 surface
 * that needs a specific position relative to the modals goes into
 * modalSurfaces at an explicit index instead — see the interleaved
 * entries there for why.
 */
export const overlaySurfaces: SurfaceEntry[] = [
  { id: 'voice-dictation', Component: VoiceDictationSurface },
]

/** Rendered INSIDE the main flex row, as siblings after <main>. */
export const sidePanelSurfaces: SurfaceEntry[] = [
  { id: 'git-bar', Component: GitBarSurface },
  { id: 'worktrees-bar', Component: WorktreesBarSurface },
  { id: 'agent-status-panel', Component: AgentStatusPanelSurface },
  { id: 'remote-panel', Component: RemotePanelSurface },
  { id: 'debug-surfaces', Component: DebugSurfaces },
]
