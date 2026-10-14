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

import { useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { HERMES_ANSWER, HERMES_CONNECTION_RESPOND } from '@providers/hermes/runtime/requestAnswers'
import { useRendererHost } from '@renderer/features/rendererHost/RendererHostContext'
import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract'
import type {
  HermesApprovalConditionState,
  HermesConnectionConditionState,
  HermesClarifyConditionState,
  HermesClarifyQuestion,
  HermesHeldConditionState,
  HermesValueConditionState,
} from '@shared/types/providerConditions'
import { withVisibleControls } from '@shared/text/visibleControls'

type HermesStateByKind = {
  'hermes.held': HermesHeldConditionState
  'hermes.connection': HermesConnectionConditionState
  'hermes.approval': HermesApprovalConditionState
  'hermes.clarify': HermesClarifyConditionState
  'hermes.sudo': HermesValueConditionState
  'hermes.secret': HermesValueConditionState
}

function isDecline(action: ConditionAction): boolean {
  if (action.kind !== 'custom') return false
  // Connection actions are keyed by their id suffix, never their label
  // (review B F9): ":approve"/":composed" go forward, the rest decline.
  if (action.name === HERMES_CONNECTION_RESPOND) return !/:(approve|composed)$/.test(action.id)
  return action.name !== HERMES_ANSWER
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

// Mirrors Hermes' strip_recommended (vendor tools/clarify_tool.py): the
// suffix is presentation, case-insensitive, trailing only.
const RECOMMENDED_LABEL = '(recommended)'
function stripRecommended(choice: string): string {
  const trimmed = choice.trim()
  return trimmed.toLowerCase().endsWith(RECOMMENDED_LABEL) ? trimmed.slice(0, -RECOMMENDED_LABEL.length).trim() : trimmed
}

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
      {question.choices.map((label) => {
        // The ANSWER is the bare choice. Hermes decorates its first choice
        // with " (Recommended)" for display (recorded S6: "a (Recommended)")
        // and its own client answered "a, c". Hermes strips the suffix only
        // from a whole answer (tools/clarify_tool.py strip_recommended /
        // _clean_answer), so "a (Recommended), c" would reach the model as
        // one unrecognised choice. The button keeps the decorated label.
        const choice = stripRecommended(label)
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
              onChange(question.choices.map(stripRecommended).filter((entry) => next.has(entry)).join(', '))
            }}
          >
            {withVisibleControls(label)}
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
            {/* A fieldset, not a <label>: a label names its FIRST labelable
                descendant, so wrapping a row of choice buttons in one renamed
                the first button to the whole question for screen readers. */}
            {state.questions.map((question) => (
              <fieldset key={question.qid} className="flex flex-col gap-1">
                <legend className="mb-1">{withVisibleControls(question.question)}</legend>
                <ClarifyQuestionField
                  question={question}
                  value={answers[question.qid] ?? ''}
                  onChange={(value) => setAnswers((current) => ({ ...current, [question.qid]: value }))}
                />
              </fieldset>
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

/**
 * "Hermes stops waiting in 1:42" (r3 A5): a sudo prompt silently timed out
 * after 120 s while the user was typing, and the click then did nothing.
 */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return <span>{left > 0 ? `Hermes stops waiting in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'Hermes has stopped waiting.'}</span>
}

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
      <p className="mb-1.5 text-[11px] text-muted">{hint}{state.expiresAt ? <> <Countdown until={state.expiresAt} /></> : null}</p>
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

// What Hermes is asking for, in words (target.kind × target.action, the
// vocabulary of tui_gateway/contracts/connectors_operation.py).
function connectionHeadline(target: HermesConnectionConditionState['targets'][number]): string {
  const name = target.catalog?.display ?? target.name
  if (target.kind === 'connector') return target.action === 'reconnect' ? `Reconnect your ${name} account` : `Connect your ${name} account`
  if (target.kind === 'mcp') return target.action === 'authorize' ? `Authorize the ${name} MCP server` : `Install the ${name} MCP server`
  if (target.kind === 'plugin') return target.action === 'enable' ? `Enable the ${name} plugin` : `Install the ${name} plugin`
  if (target.kind === 'skill') return `Install the ${name} skill`
  return `Set up ${name}`
}

// Row states in words. `initiated` WITHOUT a link is Hermes working (an
// install running on the server, recorded S28); WITH a link it is waiting on
// the user's browser (review A F2).
function stateText(target: HermesConnectionConditionState['targets'][number]): string | null {
  switch (target.state) {
    case 'pending': return null
    case 'initiated': return target.connectUrl ? 'waiting for you to finish signing in…' : 'working…'
    case 'connected': return 'connected'
    case 'skipped': return 'skipped'
    case 'failed': return 'failed'
    case 'expired': return 'the link expired'
    case 'not_connected': return 'not connected'
    default: return target.state
  }
}

/** http(s) only, again at the click (review B F3): the phone hands this to window.open. */
function safeLink(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/**
 * One row of the connection card. Typed values live only in this component:
 * kept until the answer is handed off (a refused send would otherwise make
 * the user retype a long secret, review B F6) and dropped once the row moves
 * on. They never enter condition state, logs or persistence.
 */
function ConnectionTargetRow({
  opId,
  target,
  actions,
  dispatch,
}: {
  opId: string
  target: HermesConnectionConditionState['targets'][number]
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
}) {
  const host = useRendererHost()
  // A secret's `default` is never pre-filled (review B F7; Hermes' own card does the same).
  const initial = () => Object.fromEntries(target.requiredEnv.map((field) => [field.name, field.secret ? '' : field.default]))
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [sending, setSending] = useState(false)
  const [linkProblem, setLinkProblem] = useState<string | null>(null)
  useEffect(() => {
    // The row moved on (installing, connected, skipped): the draft is spent.
    if (target.state !== 'pending' && target.state !== 'failed' && target.state !== 'expired') setValues(initial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.state])
  const mine = actions.filter((action) => action.kind === 'custom' && action.id.startsWith(`${opId}:${target.name}:`))
  const send = (action: ConditionAction) => {
    setSending(true)
    void dispatch(action).finally(() => setSending(false))
  }
  const approve = mine.find((action) => action.kind === 'custom' && action.id.endsWith(':approve'))
  const formOpen = !target.resolved && target.requiredEnv.length > 0 && (target.state === 'pending' || target.state === 'failed' || target.state === 'expired') && target.kind !== 'connector' && target.catalog?.scan?.status !== 'failed'
  const missing = target.requiredEnv.some((field) => field.required && !values[field.name]?.trim())
  const link = safeLink(target.connectUrl)
  const status = stateText(target)
  const scan = target.catalog?.scan ?? null
  return (
    <div className="mt-1.5 rounded-control border border-border bg-canvas px-2.5 py-2" data-connection-target={target.name}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-ink">{connectionHeadline(target)}</span>
        {status && <span className={`text-[11px] ${target.state === 'failed' || target.state === 'expired' ? 'text-danger' : 'text-muted'}`}>{status}</span>}
      </div>
      {target.detail && <p className="mt-0.5 text-[11px] text-ink-dim">{withVisibleControls(target.detail)}</p>}
      {target.catalog && (
        // Third-party code on the user's server: what it is and what Hermes'
        // scan said, before any button (review B F1).
        <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-ink-dim" data-connection-catalog>
          {target.catalog.description && <span>{withVisibleControls(target.catalog.description)}</span>}
          <span className="font-code text-muted">
            {[target.catalog.tier, target.catalog.repo && `${target.catalog.repo}${target.catalog.sha ? `@${target.catalog.sha.slice(0, 7)}` : ''}`].filter(Boolean).join(' · ')}
          </span>
          {scan && (
            <span className={scan.status === 'failed' ? 'text-danger' : scan.status === 'warnings' ? 'text-ink' : 'text-muted'}>
              Security scan {scan.status}{scan.summary ? `: ${scan.summary}` : ''}
            </span>
          )}
          {scan?.status === 'failed' && <span className="text-danger">Not installable from here. If you trust it anyway, install it from the terminal on your Hermes server.</span>}
        </div>
      )}
      {target.instructions && (
        // Hermes' own setup text: long, so folded; the buttons stay in reach.
        <details className="mt-1 text-[11px] text-ink-dim">
          <summary className="cursor-pointer select-none text-muted">How to set it up</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-code">{withVisibleControls(target.instructions)}</pre>
        </details>
      )}
      {!target.resolved && (
        <>
          {formOpen ? (
            <form
              className="mt-1.5 flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                if (missing || sending) return
                send({ kind: 'custom', id: `${opId}:${target.name}:composed`, label: 'Connect', name: HERMES_CONNECTION_RESPOND, payload: { opId, answer: { targets: [{ name: target.name, status: 'approved', env: values }] } } })
              }}
            >
              {target.requiredEnv.map((field) => (
                // The visible prompt IS the accessible name (review B F8);
                // the variable name is shown, not announced instead of it.
                <label key={field.name} className="flex flex-col gap-0.5 text-[11px] text-ink-dim">
                  <span>{field.prompt ?? field.name}{field.required ? '' : ' (optional)'}</span>
                  <Input
                    type={field.secret ? 'password' : 'text'}
                    autoComplete="off"
                    required={field.required}
                    aria-required={field.required}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  />
                  <span className="font-code text-[10px] text-muted">{field.name}</span>
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="submit" size="sm" disabled={missing || sending}>{target.state === 'pending' ? 'Connect' : 'Try again'}</Button>
                {mine.filter(isDecline).map((action) => (
                  <Button key={action.kind === 'custom' ? action.id : 'skip'} type="button" size="sm" variant="ghost" disabled={sending} onClick={() => send(action)}>{action.label}</Button>
                ))}
                {missing && <span className="text-[11px] text-muted">Fill in the required field{target.requiredEnv.filter((field) => field.required).length === 1 ? '' : 's'} to connect.</span>}
              </div>
            </form>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {link && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setLinkProblem(null)
                    // modifierHeld: the system browser, never the lane's
                    // pocket — a sign-in belongs where the user's accounts are.
                    void host.openExternalUrl({ url: link, sessionId: '', modifierHeld: true }).then((outcome) => {
                      if (outcome !== 'opened') setLinkProblem('The sign-in link could not be opened. Copy it below.')
                    })
                  }}
                >
                  Open sign-in
                </Button>
              )}
              {approve && <Button type="button" size="sm" disabled={sending} onClick={() => send(approve)}>{approve.label}</Button>}
              {mine.filter(isDecline).map((action) => (
                <Button key={action.kind === 'custom' ? action.id : 'skip'} type="button" size="sm" variant="ghost" disabled={sending} onClick={() => send(action)}>{action.label}</Button>
              ))}
            </div>
          )}
          {link && (
            <>
              {/* Visible and selectable (review B F9): when the browser cannot be opened, the user copies it. */}
              <p className="mt-1 select-all break-all font-code text-[10px] text-muted">{link}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                {target.kind === 'connector'
                  ? 'Sign in in your browser; this card updates when Hermes sees the account.'
                  // A catalog OAuth link redirects to 127.0.0.1 ON THE HERMES
                  // HOST (mcp_oauth.py): from this Mac it completes only if
                  // Hermes runs here or that port is tunnelled (review A F3).
                  : `This sign-in finishes on your Hermes server. If Hermes runs on a VPS, run \`hermes mcp login ${target.name}\` there instead, or tunnel its callback port.`}
              </p>
            </>
          )}
          {linkProblem && <p className="mt-1 text-[11px] text-danger">{linkProblem}</p>}
        </>
      )}
    </div>
  )
}

export const hermesConnectionView = defineView<'hermes.connection', HermesConnectionConditionState>({
  kind: 'hermes.connection',
  layout: 'strip',
  attention: (state) => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    const first = state.targets.find((target) => !target.resolved) ?? state.targets[0]
    const continueAction = actions.filter((action) => action.kind === 'custom' && action.id === `${state.opId}:continue`)
    return (
      // Titled by what is asked (review B F9): an MCP install is not "an account".
      <Card title={first ? `Hermes asks: ${connectionHeadline(first)}` : 'Hermes needs something set up'} queued={0}>
        <p className="text-[11px] text-muted">
          The reply is paused until you answer.{state.deadlineAt ? <> <Countdown until={state.deadlineAt} /></> : null}
        </p>
        {state.targets.map((target) => (
          <ConnectionTargetRow key={`${state.opId}:${target.name}`} opId={state.opId} target={target} actions={actions} dispatch={dispatch} />
        ))}
        <ActionRow actions={continueAction} dispatch={dispatch} />
      </Card>
    )
  },
})

export const hermesHeldView = defineView<'hermes.held', HermesHeldConditionState>({
  kind: 'hermes.held',
  layout: 'strip',
  // Never attention: nothing here waits on the user.
  attention: () => null,
  Component: ({ state, actions, dispatch }) =>
    state?.visible && state.held.length > 0 ? (
      <div role="group" aria-label="Waiting for Telegram" className="mx-3 mb-2 rounded-slab border border-border bg-surface px-3 py-2 text-[12px] leading-[1.55] text-ink-dim">
        <div className="mb-1 text-ink">Waiting for Telegram — Hermes is replying there. {state.held.length === 1 ? 'Your message sends' : `Your ${state.held.length} messages send`} when it finishes.</div>
        {state.held.map((hold) => (
          <div key={hold.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-code text-[11px] text-muted">{withVisibleControls(hold.text)}</span>
            <ActionRow actions={actions.filter((action) => action.kind === 'custom' && (action.payload as { holdId?: string } | undefined)?.holdId === hold.id)} dispatch={dispatch} />
          </div>
        ))}
      </div>
    ) : null,
})

export const HERMES_VIEWS: Record<string, ConditionView> = eraseRegistry<HermesStateByKind>({
  'hermes.held': hermesHeldView,
  'hermes.connection': hermesConnectionView,
  'hermes.approval': hermesApprovalView,
  'hermes.clarify': hermesClarifyView,
  'hermes.sudo': hermesSudoView,
  'hermes.secret': hermesSecretView,
})
