import { createContext, useContext } from 'react'

// CustomRenderingContext — per-session app-level flag that gates
// opt-in "richer-than-generic" feed rendering.
//
// Right now the only consumer is the git widget family in Feed.tsx:
// when this is true AND the tool call's command is a recognized git
// invocation, we swap the generic Bash/exec_command tool_use + tool_
// result rows for a purpose-built card (diff hunks, commit summary,
// status list, …). When false, everything falls through to the
// existing generic renderers so the toggle degrades perfectly to
// the pre-feature behavior.
//
// Why a context rather than a prop threading or a zustand store:
// - Feed.tsx, ClaudeRows, CodexRows, and the future git widgets are
//   all deep under the main App tree and all need to read the same
//   flag. Prop-drilling through MarkerRow / ToolBand would be noisy.
// - A tiny piece of shell UI state doesn't belong in workspaceStore
//   (which is focused on session runtime data the backend needs).
// - Default false — per user instruction this ships off by default,
//   and any consumer that renders outside the provider (tests,
//   isolated imports) should fall back to the generic renderer.
//
// No persistence at this stage. The toggle lives in memory for the
// current app session; a reload resets to off. Persisting to
// workspace.json is a one-line add when we're happy with the
// widgets and want to keep the user's preference across restarts.

export type CustomRenderingContextValue = {
  enabled: boolean
  toggle: () => void
}

const defaultValue: CustomRenderingContextValue = {
  enabled: false,
  toggle: () => {},
}

export const CustomRenderingContext =
  createContext<CustomRenderingContextValue>(defaultValue)

export function useCustomRendering(): CustomRenderingContextValue {
  return useContext(CustomRenderingContext)
}
