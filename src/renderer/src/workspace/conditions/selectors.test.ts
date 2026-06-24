import { describe, expect, it } from 'vitest'

import {
  clearConditionRuntimeState,
  conditionRequiresAttention,
  hasVisibleConditions,
} from '@renderer/workspace/conditions/selectors'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

describe('hasVisibleConditions', () => {
  it('returns false for a null snapshot', () => {
    expect(hasVisibleConditions(null)).toBe(false)
  })

  it('returns false for a non-null but empty snapshot', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {},
    }
    expect(hasVisibleConditions(snapshot)).toBe(false)
  })

  it('treats a `visible: false` flagged condition as not live', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.trust-dialog': {
          kind: 'claude.trust-dialog',
          state: { visible: false },
          actions: [],
        },
      },
    }
    expect(hasVisibleConditions(snapshot)).toBe(false)
  })

  it('treats a `visible: true` flagged condition as live', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt',
          state: { visible: true },
          actions: [],
        },
      },
    }
    expect(hasVisibleConditions(snapshot)).toBe(true)
  })

  it('treats a flagless condition (codex.approval) as live by presence', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'codex',
      ts: 1,
      conditions: {
        'codex.approval': {
          kind: 'codex.approval',
          state: {
            title: 'Approve?',
            reason: null,
            command: 'rm -rf x',
            options: ['yes', 'no'],
            selectedIndex: 0,
          },
          actions: [],
        },
      },
    }
    expect(hasVisibleConditions(snapshot)).toBe(true)
  })

  it('treats a flagless condition (claude.ask-user-question) as live by presence', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.ask-user-question': {
          kind: 'claude.ask-user-question',
          state: {
            active: true,
            mode: 'single',
            header: null,
            question: 'Pick one',
            options: [],
            cursorNumber: 1,
            submitFocused: false,
            otherNumber: null,
            chatNumber: null,
          },
          actions: [],
        },
      },
    }
    expect(hasVisibleConditions(snapshot)).toBe(true)
  })
})

describe('conditionRequiresAttention', () => {
  it('is false for null and empty snapshots', () => {
    expect(conditionRequiresAttention(null)).toBe(false)
    expect(
      conditionRequiresAttention({ provider: 'claude', ts: 1, conditions: {} }),
    ).toBe(false)
  })

  it('includes AskUserQuestion (the bug: it used to be excluded)', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.ask-user-question': {
          kind: 'claude.ask-user-question',
          state: {
            active: true,
            mode: 'single',
            header: null,
            question: 'Pick one',
            options: [],
            cursorNumber: 1,
            submitFocused: false,
            otherNumber: null,
            chatNumber: null,
          },
          actions: [],
        },
      },
    }
    expect(conditionRequiresAttention(snapshot)).toBe(true)
  })

  it('respects the visible flag for trust/permission prompts', () => {
    const hidden: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt',
          state: { visible: false },
          actions: [],
        },
      },
    }
    const visible: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt',
          state: { visible: true },
          actions: [],
        },
      },
    }
    expect(conditionRequiresAttention(hidden)).toBe(false)
    expect(conditionRequiresAttention(visible)).toBe(true)
  })

  it('does NOT treat compaction (progress, not actionable) as attention', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.compaction': {
          kind: 'claude.compaction',
          state: { visible: true, phase: 'running' },
          actions: [],
        },
      },
    }
    expect(conditionRequiresAttention(snapshot)).toBe(false)
  })

  it('treats codex approval (flagless) as attention by presence', () => {
    const snapshot: ProviderConditionSnapshot = {
      provider: 'codex',
      ts: 1,
      conditions: {
        'codex.approval': {
          kind: 'codex.approval',
          state: {
            title: 'Approve?',
            reason: null,
            command: 'rm x',
            options: ['y', 'n'],
            selectedIndex: 0,
          },
          actions: [],
        },
      },
    }
    expect(conditionRequiresAttention(snapshot)).toBe(true)
  })
})

describe('clearConditionRuntimeState', () => {
  it('nulls every condition-derived field and resets the picker', () => {
    expect(clearConditionRuntimeState()).toEqual({
      conditions: null,
      picker: { visible: false, items: [] },
      pendingApproval: null,
      pendingTrustDialog: null,
      pendingResumePrompt: null,
      pendingPermissionPrompt: null,
      pendingCompaction: null,
    })
  })
})
