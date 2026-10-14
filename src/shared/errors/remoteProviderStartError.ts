// A remote provider's start failure, carried as a type so main can journal
// WHERE it failed (#1495) without journaling the raw error text.
//
// WHY a class beside the curated sentence (and not the sentence alone): the
// sentence is what the user sees and what survives IPC laundering
// (classifySpawnFailure recognises it by inclusion). The numbers here (the
// JSON-RPC code, the HTTP status of a refused upgrade) are what a debugger
// needs to tell "Hermes too old: -32601 on client.capabilities" from "Traefik
// answered 502". They are safe to journal (fixed enums and integers, never
// server text) and never leave main: IPC relays only `message`.

import type { RemoteStartStage } from '@shared/types/session.js'

export class RemoteProviderStartError extends Error {
  constructor(
    message: string,
    readonly stage: RemoteStartStage | 'unknown',
    readonly detail: { rpcCode?: number; httpStatus?: number; method?: string } = {},
  ) {
    super(message)
    this.name = 'RemoteProviderStartError'
  }
}
