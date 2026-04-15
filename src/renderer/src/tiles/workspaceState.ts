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

export type SemanticLiveBlock = {
  blockIndex: number
  kind: string
  text?: string
  thinking?: string
  signature?: string
  citations?: unknown[]
  toolName?: string
  toolUseId?: string
  inputJson?: string
  inputJsonValid?: boolean
  parsedInput?: Record<string, unknown>
  parseError?: string
  finalized?: boolean
  resultContent?: string
  resultIsError?: boolean
  resultAt?: number
}

export type SemanticTodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

export type SemanticTaskSnapshot = {
  todos: SemanticTodoItem[]
  doneCount: number
  totalCount: number
  inProgressToolUseIds: string[]
  activeToolNames: string[]
}

export type SemanticToolCallSnapshot = {
  toolUseId: string
  blockIndex: number
  kind: string
  toolName: string | null
  status: 'in_progress' | 'completed' | 'error'
  inputJson: string
  resultContent: string | null
}

// Per-turn tool-call index. Kept intentionally minimal: only fields
// consumed by a rendered surface live here. Two fields (hasParseError,
// siblingToolUseIds) were removed after confirming no reader used
// them — the upstream Claude render layer needs them, cc-shell does
// not yet. Add back only when a real caller appears.
export type SemanticLookupSnapshot = {
  toolCallsById: Record<string, SemanticToolCallSnapshot>
  toolUseIdsInOrder: string[]
  resolvedToolUseIds: string[]
  erroredToolUseIds: string[]
}

export type SemanticLiveTurn = {
  turnId: string
  text: string
  source: string | null
  blocks: Record<number, SemanticLiveBlock>
  blockOrder: number[]
  stopReason: string | null
  usage: Record<string, number | string | undefined> | null
  task: SemanticTaskSnapshot
  lookups: SemanticLookupSnapshot
  startedAt: number
  endedAt: number | null
}

export type SemanticFlow = {
  flowId: string
  attribution: 'active' | 'secondary' | 'candidate' | 'ignored'
  reason: string
  turnId: string | null
  firstSeen: number
  lastSeen: number
  bytesEstimate: number
  chunkCount: number
}

export type SemanticLogEntry = {
  id: number
  type: string
  ts: number
  summary: string
  raw: Record<string, unknown>
}

export type SemanticErrorEntry = {
  ts: number
  kind: 'api_error' | 'stream_error'
  message: string
}

export type SemanticRuntimeState = {
  currentTurn: SemanticLiveTurn | null
  history: Array<Pick<SemanticLiveTurn, 'turnId' | 'text' | 'stopReason' | 'startedAt' | 'endedAt'>>
  flows: Record<string, SemanticFlow>
  errors: SemanticErrorEntry[]
  log: SemanticLogEntry[]
  nextLogId: number
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
  semantic: SemanticRuntimeState
}

export function emptySemanticRuntime(): SemanticRuntimeState {
  return {
    currentTurn: null,
    history: [],
    flows: {},
    errors: [],
    log: [],
    nextLogId: 1,
  }
}

export function parseSemanticTodos(
  parsedInput: Record<string, unknown> | undefined,
): SemanticTodoItem[] {
  const raw = Array.isArray(parsedInput?.todos) ? parsedInput.todos : []
  return raw.map(item => {
    const todo = (item ?? {}) as Record<string, unknown>
    const status =
      todo.status === 'in_progress' || todo.status === 'completed'
        ? todo.status
        : 'pending'
    return {
      content: typeof todo.content === 'string' ? todo.content : '',
      status,
      activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : '',
    }
  })
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
    semantic: emptySemanticRuntime(),
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
