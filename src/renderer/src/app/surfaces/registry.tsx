import type { SurfaceEntry } from './types'
import { ConfirmHost } from '@renderer/components/ui/confirm-dialog'
import { CaffeinateToastSurface } from '@renderer/features/caffeinate/surfaces/CaffeinateToastSurface'
import { VoiceDictationSurface } from '@renderer/features/voice-dictation/surfaces/VoiceDictationSurface'
import { TiledDispatchCountSurface } from '@renderer/features/workspace/surfaces/TiledDispatchCountSurface'
import { DispatchRowProjectSurface } from '@renderer/features/workspace/surfaces/DispatchRowProjectSurface'
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
import { ReorderTabsSurface } from '@renderer/features/workspace/surfaces/ReorderTabsSurface'
import { PinAgentsSurface } from '@renderer/features/dispatch-pin/surfaces/PinAgentsSurface'
import { RootManagementConfirmSurface } from '@renderer/features/workspace/surfaces/RootManagementConfirmSurface'
import { MergeProjectTabsSurface } from '@renderer/features/workspace/surfaces/MergeProjectTabsSurface'
import { CloseConfirmationSurface } from '@renderer/features/workspace/surfaces/CloseConfirmationSurface'
import { ViewPromptsSurface } from '@renderer/features/workspace/surfaces/ViewPromptsSurface'
import { ConversationsSurface } from '@renderer/features/conversations/surfaces/ConversationsSurface'
import { AgentActivitySurface } from '@renderer/features/agent-activity/surfaces/AgentActivitySurface'
import { CloseOldAgentsSurface } from '@renderer/features/workspace/surfaces/CloseOldAgentsSurface'
import { CloseCompletedAgentsSurface } from '@renderer/features/workspace/surfaces/CloseCompletedAgentsSurface'
import { BulkProviderSwitchSurface } from '@renderer/features/workspace/surfaces/BulkProviderSwitchSurface'
import { AgentViewModePickerSurface } from '@renderer/features/workspace/surfaces/AgentViewModePickerSurface'
import { ColorFlagPickerSurface } from '@renderer/features/workspace/surfaces/ColorFlagPickerSurface'
import { KeyboardShortcutsSurface } from '@renderer/features/settings/surfaces/KeyboardShortcutsSurface'
import { RewindToPromptSurface } from '@renderer/features/workspace/surfaces/RewindToPromptSurface'
import { AgentTitlePromptSurface } from '@renderer/features/workspace/surfaces/AgentTitlePromptSurface'
import { AppHostSurface } from '@renderer/apps/surfaces/AppHostSurface'
import { ProviderSwitchPickerSurface } from '@renderer/features/workspace/surfaces/ProviderSwitchPickerSurface'
import { KeyVaultModalSurface } from '@renderer/features/key-vault/surfaces/KeyVaultModalSurface'
import { NewAgentInSurface } from '@renderer/features/workspace/surfaces/NewAgentInSurface'
import { ReportHistorySurface } from '@renderer/features/tldr/surfaces/ReportHistorySurface'
import { AgentAnalyticsSurface } from '@renderer/features/agent-analytics/surfaces/AgentAnalyticsSurface'
import { McpServerDialogSurface } from '@renderer/features/mcp/surfaces/McpServerDialogSurface'
import { AddSkillDialogSurface } from '@renderer/features/skills/surfaces/AddSkillDialogSurface'
import { AgentMcpServersSurface } from '@renderer/features/mcp/surfaces/AgentMcpServersSurface'

// The surface registry (issue #494). Adding a surface = write a wrapper
// in the owning feature's surfaces/ folder + add ONE import + ONE array
// entry here. App.tsx is never edited.
//
// HOW STACKING ACTUALLY WORKS (#512, corrected in review): the layers are
// named in ui/layers.ts. Almost every entry here renders the shared Radix
// Dialog (LAYERS.dialog; the caffeinate entry renders nothing and forwards to
// the app toast). A Dialog's content portals into <body> when it OPENS, so
// between two open dialogs the one OPENED LATER paints on top, whatever their
// order in this array. Array order only decides between dialogs that open in
// the same React commit. A surface that must always sit above another needs
// an explicit mechanism (its own layer in ui/layers.ts), not an array index.
//
// The order below is still the exact order App.tsx rendered these surfaces
// before the extraction; keep new entries at the END so same-commit ties do
// not move.

/** Rendered at the app root, after the overlays. */
export const modalSurfaces: SurfaceEntry[] = [
  { id: 'command-palette', Component: CommandPaletteSurface },
  { id: 'path-picker', Component: PathPickerSurface },
  // ⚠ Two non-modal surfaces interleaved into the modal stack ON PURPOSE.
  // Pre-refactor App.tsx rendered them exactly here — after the palette
  // and path picker, before the tile-tabs..usage modals — and that DOM
  // position was load-bearing when these were fixed z-50 siblings. Today
  // both are Dialogs in LAYERS.dialog, so the count prompt paints above the
  // palette because it OPENS after it (tiled dispatch fires from an open
  // palette); this position only still decides a same-commit tie. The
  // caffeinate entry now forwards to the app toast, which has its own layer:
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
  { id: 'dispatch-row-project', Component: DispatchRowProjectSurface },
  { id: 'caffeinate-toast', Component: CaffeinateToastSurface },
  { id: 'keyboard-shortcuts', Component: KeyboardShortcutsSurface },
  { id: 'reorder-tabs', Component: ReorderTabsSurface },
  { id: 'pin-agents', Component: PinAgentsSurface },
  { id: 'close-confirmation', Component: CloseConfirmationSurface },
  { id: 'debug-bundle-note', Component: DebugBundleNoteSurface },
  { id: 'recording-note', Component: RecordingNoteSurface },
  { id: 'view-prompts', Component: ViewPromptsSurface },
  { id: 'conversations', Component: ConversationsSurface },
  { id: 'agent-activity', Component: AgentActivitySurface },
  { id: 'close-old-agents', Component: CloseOldAgentsSurface },
  { id: 'close-completed-agents', Component: CloseCompletedAgentsSurface },
  { id: 'bulk-provider-switch', Component: BulkProviderSwitchSurface },
  { id: 'agent-view-mode-picker', Component: AgentViewModePickerSurface },
  { id: 'color-flag-picker', Component: ColorFlagPickerSurface },
  { id: 'rewind-to-prompt', Component: RewindToPromptSurface },
  { id: 'agent-title-prompt', Component: AgentTitlePromptSurface },
  { id: 'usage', Component: UsageModalSurface },
  // New modals append so a same-commit tie cannot move an established
  // surface; see the stacking note above.
  { id: 'provider-switch-picker', Component: ProviderSwitchPickerSurface },
  { id: 'key-vault', Component: KeyVaultModalSurface },
  // Appended per the contract above. It is only opened from a command, which
  // closes the palette first, so it has no stacking relationship to reason
  // about beyond "a new modal paints over the established ones".
  { id: 'new-agent-in', Component: NewAgentInSurface },
  // Appended per the contract above. Opened only from a session command that
  // closes the palette first; it must paint over every established modal so
  // the warning is never hidden behind the surface it is warning about.
  { id: 'root-management-confirm', Component: RootManagementConfirmSurface },
  // Appended per the contract above; opened only from a command that closes
  // the palette first (#913).
  { id: 'merge-project-tabs', Component: MergeProjectTabsSurface },
  // Appended per the contract above. Opened only from a session command that
  // closes the palette first, so it stacks over established modals by order.
  { id: 'tldr-history', Component: ReportHistorySurface },
  // Appended per the contract above (#964). Opened only from a command that
  // closes the palette first, so it stacks over established modals by order.
  { id: 'agent-analytics', Component: AgentAnalyticsSurface },
  // Appended per the contract above (#1143); both are opened from commands
  // that close the palette first. The per-agent picker can hand off to the
  // root-management confirmation (earlier in this array), but it closes itself
  // before opening it, so the two are never on screen together and the order
  // between them does not matter.
  { id: 'agent-mcp-servers', Component: AgentMcpServersSurface },
  { id: 'mcp-server-dialog', Component: McpServerDialogSurface },
  // Appended per the contract above (#1161). Opened from the Skills grid, the
  // "Add Skill…" command (which closes the palette first) and an external
  // skill's "Manage with Agent Code"; it stacks over Settings by order.
  { id: 'add-skill-dialog', Component: AddSkillDialogSurface },
  // Built-in apps host. Last in the array, which per the paint-order contract
  // above means it paints above every modal already mounted. That placement is
  // reasoned, not defaulted: an app is always user-initiated from the palette and
  // is the thing awaiting input for as long as it is open, so nothing already on
  // screen has a claim to cover it. No app has a reason to sit *under* another
  // modal — if one ever does, that is a signal it should not be an app.
  { id: 'app-host', Component: AppHostSurface },
  // The shared in-app confirm (replaced window.confirm, keyboard-first plan
  // D8). LAST, after even app-host, because a confirm is always a question
  // ABOUT the surface underneath it — the Conventions editor asking "discard
  // changes?", Key Vault asking "delete key?" — so it must paint above
  // whichever surface asked. It renders nothing until requestConfirm queues
  // a request.
  { id: 'confirm-dialog', Component: ConfirmHost },
  // #512: RemotePanel renders a centred Radix Dialog, but was registered as a
  // side panel, so it mounted inside the main row and only painted as a modal
  // because DialogContent portals out. It is a modal; it lives here, appended
  // per the contract above (its portal stacks by open order either way).
  { id: 'remote-panel', Component: RemotePanelSurface },
]

/**
 * Rendered at the app root, after the main row, BEFORE the modals — so
 * everything in this array paints UNDER the modal stack when z-indexes
 * tie. Voice dictation's chip is in LAYERS.toast, above every dialog on
 * purpose (dictating into a dialog must stay visible), so its position here
 * no longer decides its stacking. A surface that needs a specific position
 * relative to the modals goes into modalSurfaces at an explicit index
 * instead — see the interleaved entries there for why.
 */
export const overlaySurfaces: SurfaceEntry[] = [
  { id: 'voice-dictation', Component: VoiceDictationSurface },
]

/** Rendered INSIDE the main flex row, as siblings after <main>. */
export const sidePanelSurfaces: SurfaceEntry[] = [
  { id: 'git-bar', Component: GitBarSurface },
  { id: 'worktrees-bar', Component: WorktreesBarSurface },
  { id: 'agent-status-panel', Component: AgentStatusPanelSurface },
  { id: 'debug-surfaces', Component: DebugSurfaces },
]
