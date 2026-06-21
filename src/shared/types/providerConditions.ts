export type ConditionPtyAction = {
  kind: 'pty'
  id: string
  label: string
  data: string
}

export type ConditionCustomAction = {
  kind: 'custom'
  id: string
  label: string
  name: string
}

export type ConditionAction = ConditionPtyAction | ConditionCustomAction

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

// Mirror of `AskUserQuestionState` from the claude-code-headless package's
// AskUserQuestionParser. WHY duplicated rather than imported: this shared
// types module is the renderer/main IPC contract and must not depend on the
// headless package's build output (the same reason codex-headless duplicates
// its condition types). The two shapes MUST stay in lockstep — if the parser
// gains a field, add it here too.
//
// The PRESENCE of this state (a live `claude.ask-user-question` condition)
// is the authoritative "the AskUserQuestion picker is on screen right now"
// signal the renderer gates the native picker row on. `active` is always
// true when the condition exists; the cursor/toggle fields are carried for
// the later multi-select / free-text answering PR and are unused by this
// PR's read-only render.
export type ClaudeAskUserQuestionOption = {
  number: number
  label: string
  toggled?: boolean
}

export type ClaudeAskUserQuestionState = {
  active: true
  mode: 'single' | 'multi'
  header: string | null
  question: string | null
  options: ClaudeAskUserQuestionOption[]
  cursorNumber: number | null
  submitFocused: boolean
  otherNumber: number | null
  chatNumber: number | null
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
      // Added as a first-class condition kind (PR-2a of #289) so the
      // AskUserQuestion picker has the same condition surface as the slash
      // picker / permission prompt. NOTE: in this PR the LIVE state is
      // actually carried to the renderer on the `screen` snapshot
      // (`snap.askUserQuestion`, mirroring `snap.picker`) — the same
      // working path the slash picker uses — and this union arm makes the
      // type a recognized condition for downstream consumers / future
      // condition-pipeline use. `actions` is empty for now: answering
      // (multi-select / free-text) is a follow-up PR; this PR is read-only.
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
