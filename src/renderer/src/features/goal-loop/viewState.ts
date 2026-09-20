import { create } from 'zustand'

// Latch only, deliberately: a hold-peek answers "what is the state" but the
// goal loop surface's job is control (pause/resume/raise/stop), which needs
// a stable latch. Separate from tldr's PreviewKind because that union drives
// TldrOverlay's identity-keyed data flow; loops are session-keyed with a
// different lifecycle. Not in persisted state for the same reason as the
// tldr preview: a renderer restart must not restore a darkened UI.
export const useGoalLoopView = create<{ latched: boolean }>(() => ({ latched: false }))
export function dismissGoalLoop(): void { useGoalLoopView.setState({ latched: false }) }
export function toggleGoalLoop(): void { useGoalLoopView.setState(state => ({ latched: !state.latched })) }
