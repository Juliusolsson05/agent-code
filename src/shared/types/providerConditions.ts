// The generic wire ACTION primitives now live in conditions-core/contract.ts
// (the provider-agnostic source of truth for the registry framework). We
// import them here so the provider condition unions below can keep referencing
// `ConditionAction`, AND re-export them so every existing import of these names
// from '@shared/types/providerConditions' keeps working byte-for-byte — this
// file remains the home of the provider-SPECIFIC state shapes + condition
// unions below. A bare `export type { … } from` would NOT bind these names into
// this module's local scope, so the unions below (which use `ConditionAction`)
// would fail to resolve; importing first is what keeps them visible here.
// See docs/design/conditions-system.md.
import type {
  ConditionPtyAction,
  ConditionCustomAction,
  ConditionAction,
} from '@shared/conditions-core/contract'

export type { ConditionPtyAction, ConditionCustomAction, ConditionAction }

export type ClaudeTrustDialogState = {
  visible: boolean
  options?: Array<{ key: string; label: string }>
  workspace?: string
}

export type ClaudeResumePromptState = {
  visible: boolean
  sessionAgeText?: string
  tokenCountText?: string
  selectedIndex?: number
}

export type ClaudePermissionPromptState = {
  visible: boolean
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
  selectedIndex?: number
}

export type ClaudeCompactionState = {
  visible: boolean
  phase?: 'running' | 'error' | 'done'
  statusText?: string
  errorText?: string
}

// AskUserQuestion picker state (PR-4). This MUST stay structurally identical to
// `AskUserQuestionState` / `AskUserQuestionOption` in claude-code-headless's
// AskUserQuestionParser.ts — that parser produces the value, this is the
// app-side mirror the wire snapshot is typed against (the submodule import wall
// means we can't import the headless type directly). If the parser's shape
// changes, this must change with it.
//
// Unlike the modal states above there is NO `visible: boolean` field: the parser
// returns `null` when no picker is on screen and a `{ active: true, … }` record
// when one is, so presence is "the record exists", not a flag. `active` is
// always true when present (a convenience for consumers that destructure without
// a null-check first).
export type ClaudeAskUserQuestionOption = {
  // The on-screen 1-based number; in single-select it is ALSO the exact answer
  // keystroke (see the askUserQuestion module's action contract).
  number: number
  label: string
  // Multi-select only: the live checkbox state. `undefined` in single-select.
  toggled?: boolean
}

export type ClaudeAskUserQuestionState = {
  active: true
  mode: 'single' | 'multi'
  header: string | null
  question: string | null
  // Real numbered options INCLUDING the auto-injected "Type something" row,
  // EXCLUDING the below-divider "Chat about this" footer.
  options: ClaudeAskUserQuestionOption[]
  // Row the `❯` cursor sits on, or null when the cursor is on the Submit row.
  cursorNumber: number | null
  // Multi-select: true when `❯` is on the focusable "Submit" row.
  submitFocused: boolean
  // The "Type something" free-text row's number, or null if absent.
  otherNumber: number | null
  // The "Chat about this" footer row's number, or null if absent.
  chatNumber: number | null
}

export type PickerItem = {
  id: string
  label: string
  description: string
  selected: boolean
}

export type ClaudeSlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

export type CodexTrustDialogState = {
  visible: boolean
  workspace?: string
  options?: Array<{ key: string; label: string }>
}

export type CodexApprovalState = {
  title: string
  reason: string | null
  command: string | null
  options: string[]
  selectedIndex: number
  callId?: string | null
  commandParts?: string[]
  workdir?: string | null
}

export type ClaudeCondition =
  | {
      kind: 'claude.trust-dialog'
      state: ClaudeTrustDialogState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.resume-prompt'
      state: ClaudeResumePromptState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.permission-prompt'
      state: ClaudePermissionPromptState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.compaction'
      state: ClaudeCompactionState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.slash-picker'
      state: ClaudeSlashPickerState
      actions: ConditionAction[]
    }
  | {
      kind: 'claude.ask-user-question'
      state: ClaudeAskUserQuestionState
      actions: ConditionAction[]
    }

export type ClaudeConditionKind = ClaudeCondition['kind']

export type ClaudeConditionMap = Partial<{
  [K in ClaudeConditionKind]: Extract<ClaudeCondition, { kind: K }>
}>

export type ClaudeConditionSnapshot = {
  provider: 'claude'
  conditions: ClaudeConditionMap
  ts: number
}

export type CodexCondition =
  | {
      kind: 'codex.trust-dialog'
      state: CodexTrustDialogState
      actions: ConditionAction[]
    }
  | {
      kind: 'codex.approval'
      state: CodexApprovalState
      actions: ConditionAction[]
    }
  | {
      kind: 'codex.switch-model-prompt'
      state: {
        visible: true
        message: string
        selectedIndex?: number
        options?: string[]
      }
      actions: ConditionAction[]
    }

export type CodexConditionKind = CodexCondition['kind']

export type CodexConditionMap = Partial<{
  [K in CodexConditionKind]: Extract<CodexCondition, { kind: K }>
}>

export type CodexConditionSnapshot = {
  provider: 'codex'
  conditions: CodexConditionMap
  ts: number
}

export type ProviderConditionSnapshot =
  | ClaudeConditionSnapshot
  | CodexConditionSnapshot
