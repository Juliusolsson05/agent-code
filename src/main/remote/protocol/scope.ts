import { inboundFrameSchema, type InboundFrame } from '@main/remote/protocol/messages.js'

// The v1 scope gate. One function, one job: nothing reaches a RemoteServer
// handler unless it round-trips through the inbound schema union. The
// allow-list is not a separate string array to keep in sync — the
// discriminated union in messages.ts IS the allow-list, so an out-of-scope
// type fails the same parse as a malformed in-scope message. scope.test.ts
// pins both directions (allowed types parse; amputated capabilities don't),
// so widening the protocol forces a visible test edit.

export type ParseInboundResult =
  | { ok: true; frame: InboundFrame }
  | { ok: false; reason: string }

export function parseInboundFrame(raw: unknown): ParseInboundResult {
  const parsed = inboundFrameSchema.safeParse(raw)
  if (!parsed.success) {
    // The zod issue list can nest deeply for union failures; one flat line
    // is enough for the reply/error frame and the journal. Never echo the
    // raw payload back — it came from an untrusted socket.
    const first = parsed.error.issues[0]
    return {
      ok: false,
      reason: first
        ? `${first.path.join('.') || '<root>'}: ${first.message}`
        : 'invalid frame',
    }
  }
  return { ok: true, frame: parsed.data }
}
