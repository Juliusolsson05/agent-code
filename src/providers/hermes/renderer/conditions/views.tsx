// Hermes condition views (#1482): INLINE CARDS, not modals.
//
// WHY cards: the Hermes pane replaces a Telegram chat, where a bot's question
// sits in the conversation with its buttons under it and the user can still
// scroll and read what led to it. TileLeaf renders the condition outlet
// between the chat and the composer, so a card here is exactly that: the
// prompt in the chat's own flow. (The modal ConditionPromptShell suits a
// coding agent's one-off permission; a chat agent asks questions all day.)
//
// The runtime authors every one-click choice (approval choices, a single
// clarify question's options, Skip). Typed answers (sudo password, secret,
// free-text or multi-select clarify) are VIEW state: the view composes a
// HERMES_ANSWER payload and HermesSession.resolveCondition validates it
// against the live request (requestAnswers.ts validateAnswer), so a view can
// compose an answer but never invent one.
//
// Secrets: a typed sudo password or secret is held only in this component's
// state until submit, sent once (renderer → main → Hermes), and cleared.
// Nothing persists it; the condition state never contains it.

import { useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { HERMES_ANSWER } from '@providers/hermes/runtime/requestAnswers'
import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract'
import type {
  HermesApprovalConditionState,
  HermesClarifyConditionState,
  HermesClarifyQuestion,
  HermesValueConditionState,
} from '@shared/types/providerConditions'
import { withVisibleControls } from '@shared/text/visibleControls'

type HermesStateByKind = {
  'hermes.approval': HermesApprovalConditionState
  'hermes.clarify': HermesClarifyConditionState
  'hermes.sudo': HermesValueConditionState
  'hermes.secret': HermesValueConditionState
}

function isDecline(action: ConditionAction): boolean {
  return action.kind === 'custom' && action.name !== HERMES_ANSWER
}

function Card({ title, queued, children }: { title: string; queued: number; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={title}
      className="mx-3 mb-2 rounded-slab border border-accent/60 bg-surface px-3 py-2.5 text-[12px] leading-[1.55] text-ink shadow-sm"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium text-ink">☤ {title}</span>
        {queued > 0 && <span className="text-[11px] text-muted">+{queued} more waiting</span>}
      </div>
      {children}
    </div>
  )
}

function ActionRow({ actions, dispatch, disabled }: { actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void>; disabled?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((action, index) => (
        <Button
          key={action.kind === 'custom' ? action.id : `pty-${index}`}
          type="button"
          size="sm"
          variant={isDecline(action) ? 'ghost' : 'default'}
          disabled={disabled}
          onClick={() => void dispatch(action)}
        >
          {withVisibleControls(action.label)}
        </Button>
      ))}
    </div>
  )
}

function composed(requestId: string, result: unknown, label: string): ConditionCustomAction {
  return { kind: 'custom', id: `${requestId}:composed`, label, name: HERMES_ANSWER, payload: { requestId, result } }
}

export const hermesApprovalView = defineView<'hermes.approval', HermesApprovalConditionState>({
  kind: 'hermes.approval',
  layout: 'strip',
  attention: (state) => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <Card title="Hermes wants to run a command" queued={state.queued}>
        {state.description && <p className="mb-1 text-ink-dim">{withVisibleControls(state.description)}</p>}
        {/* Bounded and scrolling: the command is what the user approves, so it
            is shown in full (never truncated) without pushing the buttons out
            of reach (the OpenCode #878 lesson). Hermes redacts secrets in it
            server-side. */}
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-canvas px-2 py-1.5 font-code text-[11px] text-ink">
          {withVisibleControls(state.command)}
        </pre>
        <ActionRow actions={actions} dispatch={dispatch} />
      </Card>
    )
  },
})

function ClarifyQuestionField({
  question,
  value,
  onChange,
}: {
  question: HermesClarifyQuestion
  value: string
  onChange: (value: string) => void
}) {
  if (question.choices.length === 0) {
    return <Input aria-label={question.question} value={value} onChange={(event) => onChange(event.target.value)} placeholder="Your answer" />
  }
  // Hermes reads a multi-select answer as one string; ", " joins choices the
  // way its own clients send them (recorded S6: "a, c").
  const selected = new Set(value ? value.split(', ') : [])
  return (
    <div className="flex flex-wrap gap-1.5">
      {question.choices.map((choice) => {
        const active = selected.has(choice)
        return (
          <Button
            key={choice}
            type="button"
            size="sm"
            variant={active ? 'default' : 'outline'}
            aria-pressed={active}
            onClick={() => {
              if (!question.multiSelect) return onChange(choice)
              const next = new Set(selected)
              if (active) next.delete(choice)
              else next.add(choice)
              onChange(question.choices.filter((entry) => next.has(entry)).join(', '))
            }}
          >
            {withVisibleControls(choice)}
          </Button>
        )
      })}
    </div>
  )
}

function ClarifyCard({ state, actions, dispatch }: { state: HermesClarifyConditionState; actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const single = state.questions.length === 1 && !state.questions[0].multiSelect && state.questions[0].choices.length > 0
  return (
    <Card title={state.questions.length === 1 ? 'Hermes has a question' : 'Hermes has a few questions'} queued={state.queued}>
      {single ? (
        <>
          <p className="mb-1">{withVisibleControls(state.questions[0].question)}</p>
          {/* One single-choice question: the runtime's one-click actions. */}
          <ActionRow actions={actions} dispatch={dispatch} />
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const result = { answers: Object.fromEntries(state.questions.map((question) => [question.qid, answers[question.qid]?.trim() ? answers[question.qid] : null])) }
            void dispatch(composed(state.requestId, result, 'Send answers'))
          }}
        >
          <div className="flex flex-col gap-2.5">
            {state.questions.map((question) => (
              <label key={question.qid} className="flex flex-col gap-1">
                <span>{withVisibleControls(question.question)}</span>
                <ClarifyQuestionField
                  question={question}
                  value={answers[question.qid] ?? ''}
                  onChange={(value) => setAnswers((current) => ({ ...current, [question.qid]: value }))}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button type="submit" size="sm">Send answers</Button>
            {actions.filter(isDecline).map((action) => (
              <Button key={action.kind === 'custom' ? action.id : 'decline'} type="button" size="sm" variant="ghost" onClick={() => void dispatch(action)}>
                {action.label}
              </Button>
            ))}
          </div>
        </form>
      )}
    </Card>
  )
}

export const hermesClarifyView = defineView<'hermes.clarify', HermesClarifyConditionState>({
  kind: 'hermes.clarify',
  layout: 'strip',
  attention: (state) => (state?.visible ? 'ACTION' : null),
  // Keyed by request so a NEW question never inherits the last one's typed
  // answers (component state would otherwise survive the swap).
  Component: ({ state, actions, dispatch }) =>
    state?.visible ? <ClarifyCard key={state.requestId} state={state} actions={actions} dispatch={dispatch} /> : null,
})

function ValueCard({
  title,
  state,
  actions,
  dispatch,
  hint,
}: {
  title: string
  state: HermesValueConditionState
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
  hint: string
}) {
  const [value, setValue] = useState('')
  return (
    <Card title={title} queued={state.queued}>
      {state.prompt && (
        <pre className="mb-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-control bg-canvas px-2 py-1.5 font-code text-[11px]">
          {withVisibleControls(state.prompt)}
        </pre>
      )}
      <p className="mb-1.5 text-[11px] text-muted">{hint}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const answer = value
          // Clear before dispatch: the typed secret leaves component state as
          // soon as it is handed off.
          setValue('')
          void dispatch(composed(state.requestId, { value: answer }, 'Send'))
        }}
        className="flex gap-1.5"
      >
        <Input type="password" autoComplete="off" aria-label={title} value={value} onChange={(event) => setValue(event.target.value)} />
        <Button type="submit" size="sm" disabled={!value}>Send</Button>
        {actions.filter(isDecline).map((action) => (
          <Button key={action.kind === 'custom' ? action.id : 'decline'} type="button" size="sm" variant="ghost" onClick={() => void dispatch(action)}>
            {action.label}
          </Button>
        ))}
      </form>
    </Card>
  )
}

export const hermesSudoView = defineView<'hermes.sudo', HermesValueConditionState>({
  kind: 'hermes.sudo',
  layout: 'strip',
  attention: (state) => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) =>
    state?.visible ? (
      <ValueCard
        key={state.requestId}
        title="Hermes needs the sudo password"
        hint="Sent once to your Hermes server for this command. Agent Code does not store it. Skip runs the command without sudo."
        state={state}
        actions={actions}
        dispatch={dispatch}
      />
    ) : null,
})

export const hermesSecretView = defineView<'hermes.secret', HermesValueConditionState>({
  kind: 'hermes.secret',
  layout: 'strip',
  attention: (state) => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) =>
    state?.visible ? (
      <ValueCard
        key={state.requestId}
        title={state.envVar ? `Hermes needs ${state.envVar}` : 'Hermes needs a secret'}
        hint="Hermes saves this on your server (its .env) for the skill that asked. Agent Code does not store it."
        state={state}
        actions={actions}
        dispatch={dispatch}
      />
    ) : null,
})

export const HERMES_VIEWS: Record<string, ConditionView> = eraseRegistry<HermesStateByKind>({
  'hermes.approval': hermesApprovalView,
  'hermes.clarify': hermesClarifyView,
  'hermes.sudo': hermesSudoView,
  'hermes.secret': hermesSecretView,
})
