import { create } from 'zustand'

// Correlation marker for the "answer via message" workaround.
//
// WHY this store has to exist: when we answer an AskUserQuestion by dismissing
// the picker (Esc) and sending the choices as a prompt, Claude records the tool
// as *declined* with a GENERIC rejection result — byte-identical whether the
// user abandoned the question or answered it via message (captured live, see
// docs/decomposition/evidence/auq-decline/). The transcript therefore cannot
// tell the feed "this decline is actually an answer." So the renderer that
// performs the workaround records the fact here, keyed by the AskUserQuestion
// `operationId`, and the answered row reads it to render "answered via message"
// instead of a failure.
//
// It is a plain in-memory store (not persisted): it only needs to make the
// current session's feed honest. On reload the durable transcript shows the
// decline + the user's answer message, which is a truthful record on its own.

type AnsweredViaMessageState = {
  /** operationId → human-readable summary lines of what was answered. */
  byOperationId: Record<string, string[]>
  mark: (operationId: string, summaryLines: string[]) => void
}

export const useAnsweredViaMessageStore = create<AnsweredViaMessageState>(set => ({
  byOperationId: {},
  mark: (operationId, summaryLines) =>
    set(state => ({
      byOperationId: { ...state.byOperationId, [operationId]: summaryLines },
    })),
}))

// Submit latch for a question, keyed by operationId.
//
// WHY this is a store and not a ref inside AskUserQuestionRow: since #738 the
// committed card renders a NEW AskUserQuestionRow instance for a question the
// live row may still be answering — the live-plane row unmounts when the
// rendering ledger hands the tool_use to the committed row, which can happen
// while the headless resolver is still writing the first answer into the
// terminal. A per-instance latch (useState/useRef) dies with the instance, so
// the fresh committed row would accept a second click and interleave a second
// answer's keystrokes with the first. Keying the latch by operationId makes it
// follow the QUESTION, not the row.
//
// WHY the reads are synchronous getState() calls: the guard must catch two
// clicks dispatched in the SAME tick (a fast double-click); a React-subscribed
// value only updates on the next render. zustand's `set` is synchronous, so a
// second handler in the same tick observes the first one's write.
//
// The latch is cleared on structured/rejected resolver failure so the user can
// retry; on the happy path the durable result (or the answered-via-message
// marker) takes over and the latch is simply left set — nothing reads it once
// the question has an answer, and it is session-local memory.

type AnswerSubmissionState = {
  inFlight: Record<string, true>
  begin: (operationId: string) => void
  end: (operationId: string) => void
}

export const useAnswerSubmissionStore = create<AnswerSubmissionState>(set => ({
  inFlight: {},
  begin: operationId =>
    set(state => ({ inFlight: { ...state.inFlight, [operationId]: true } })),
  end: operationId =>
    set(state => {
      if (!(operationId in state.inFlight)) return state
      const { [operationId]: _dropped, ...rest } = state.inFlight
      return { inFlight: rest }
    }),
}))

export function isAnswerInFlight(operationId: string): boolean {
  return useAnswerSubmissionStore.getState().inFlight[operationId] === true
}

export function beginAnswer(operationId: string): void {
  useAnswerSubmissionStore.getState().begin(operationId)
}

export function endAnswer(operationId: string): void {
  useAnswerSubmissionStore.getState().end(operationId)
}
