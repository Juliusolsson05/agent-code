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
