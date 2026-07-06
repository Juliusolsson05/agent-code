// Claude condition policy (#394 phase 3) — the per-provider data the
// generic workspace condition selectors consume. Previously these
// lived as hardcoded kind-string lists + `provider === 'claude'`
// branches inside workspace/conditions/selectors.ts (the exact seam
// docs/design/conditions-system.md and conditions-core/view.ts:27-32
// deferred: "the migration is a deletion, not a re-derivation").
//
// WHY policy data instead of deriving from the registered views'
// `attention()` fns: the sets and the views deliberately DISAGREE —
// ask-user-question is attention-worthy but has NO outlet view (it
// renders as a feed row), while compaction HAS a view with an
// attention fn but is excluded from the attention set (progress, not
// actionable). Derivation from views would silently change both.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'

export const CLAUDE_CONDITION_POLICY: ProviderConditionPolicy = {
  // Live, user-actionable prompts. EXCLUDES claude.compaction
  // (progress, not actionable) and claude.slash-picker (a composer
  // affordance, not an attention surface).
  attentionKinds: new Set([
    'claude.trust-dialog',
    'claude.resume-prompt',
    'claude.permission-prompt',
    'claude.ask-user-question',
  ]),
  // Blocking-input kinds for keystroke routing (presence-gated, not
  // visible-gated — see hasActionCondition's docstring). Same
  // membership as attentionKinds today; kept separate because the
  // gates differ and a future kind may belong to one but not the
  // other.
  actionKinds: new Set([
    'claude.trust-dialog',
    'claude.resume-prompt',
    'claude.permission-prompt',
    'claude.ask-user-question',
  ]),
  // Priority-ordered dispatch badge rules — first match wins.
  // 'QUESTION' is deliberately outside conditions-core's
  // AttentionLevel union; dispatch badges are free-form strings.
  attentionLabels: [
    { kind: 'claude.permission-prompt', label: 'ACTION' },
    // A live AskUserQuestion picker means the agent is BLOCKED
    // waiting for the user to choose — it needs attention just like
    // a permission/trust prompt.
    { kind: 'claude.ask-user-question', label: 'QUESTION' },
    { kind: 'claude.trust-dialog', label: 'TRUST' },
    { kind: 'claude.resume-prompt', label: 'RESUME' },
    {
      kind: 'claude.compaction',
      // Compaction is a badge only when it FAILED — running/done
      // phases are progress, not attention.
      label: state =>
        (state as { phase?: string } | null)?.phase === 'error' ? 'ERROR' : null,
    },
  ],
  // The composer's slash-command dropdown reads this kind's state.
  composerPickerKind: 'claude.slash-picker',
}
