import type { Dispatch, SetStateAction } from 'react'

import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

export type WorkspaceSetState = (
  next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState),
) => void

export type WorkspaceSetRuntimes = (
  next:
    | Record<SessionId, SessionRuntime>
    | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
) => void

export type WorkspaceSetSpotlight = (
  next:
    | SpotlightState
    | null
    | ((prev: SpotlightState | null) => SpotlightState | null),
) => void

export type WorkspaceSetTileTabs = (
  next:
    | TileTabsState
    | null
    | ((prev: TileTabsState | null) => TileTabsState | null),
) => void

export type WorkspaceSetReaderMode = (
  next:
    | ReaderModeState
    | null
    | ((prev: ReaderModeState | null) => ReaderModeState | null),
) => void
