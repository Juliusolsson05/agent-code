import type {
  SessionId,
  SplitDirection,
  TabId,
} from './types'
import type { Entry } from '../../../shared/types/transcript'

export type PickerItem = {
  id: string
  label: string
  description: string
  selected: boolean
}

export type SlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

export type QueuedMessage = {
  content: string
  timestamp: string
}

export type SessionRuntime = {
  screen: string
  screenMarkdown: string
  recentScreen: string
  recentScreenMarkdown: string
  streamingBaseline: string | null
  entries: Entry[]
  awaitingAssistant: boolean
  queuedMessages: QueuedMessage[]
  exited: number | null
  projectDir: string | null
  picker: SlashPickerState
  draftInput: string
  activityStatus: string | null
  paneToast: string | null
  pendingApproval: {
    callId: string | null
    command: string[]
    workdir: string | null
    reason?: string | null
    options?: string[]
    selectedIndex?: number
  } | null
  pendingTrustDialog: {
    workspace?: string
  } | null
  pendingResumePrompt: {
    sessionAgeText?: string
    tokenCountText?: string
    options?: string[]
    selectedIndex?: number
  } | null
  pendingCompaction: {
    phase: 'running' | 'error' | 'done'
    statusText?: string
    errorText?: string
  } | null
  historyOldestMarker: string | null
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  tailMode: boolean
  assistantPicker: { selectedUuid: string } | null
}

export function emptyRuntime(): SessionRuntime {
  return {
    screen: '',
    screenMarkdown: '',
    recentScreen: '',
    recentScreenMarkdown: '',
    streamingBaseline: null,
    entries: [],
    awaitingAssistant: false,
    queuedMessages: [],
    exited: null,
    projectDir: null,
    picker: { visible: false, items: [] },
    draftInput: '',
    activityStatus: null,
    paneToast: null,
    pendingApproval: null,
    pendingTrustDialog: null,
    pendingResumePrompt: null,
    pendingCompaction: null,
    historyOldestMarker: null,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    tailMode: false,
    assistantPicker: null,
  }
}

export type SpotlightState = {
  tabId: TabId
  focusedSessionId: SessionId
}

export type ReaderModeState = {
  tabId: TabId
  focusedSessionId: SessionId
}

export type TileTabsState = {
  tabIds: TabId[]
  focusedTabId: TabId
  direction: SplitDirection
  ratios: number[]
}
