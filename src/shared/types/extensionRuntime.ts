import { z } from 'zod'

import { isExtensionJson, type ExtensionJson } from './extensionJson.js'
import { extensionFileReadRequestSchema, extensionServiceRequestSchema } from './extensionServices.js'
export { isExtensionJson, type ExtensionJson } from './extensionJson.js'

export const extensionJsonSchema = z.custom<ExtensionJson>(isExtensionJson, 'Expected bounded JSON (4096 values, depth 32, 128 Ki characters)')
const storageKey = z.string().min(1).max(256).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key))
const identifier = z.string().min(1).max(96)

// This transport is deliberately independent of the application's generic IPC
// catalog. A runtime can request only these methods, and main derives its owner
// from the registered WebContents rather than accepting an extension id here.
export const runtimeApiRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('storage.get'), key: storageKey }).strict(),
  z.object({ method: z.literal('storage.set'), key: storageKey, value: extensionJsonSchema }).strict(),
  z.object({ method: z.literal('storage.delete'), key: storageKey }).strict(),
  z.object({ method: z.literal('storage.keys') }).strict(),
  z.object({ method: z.literal('views.publish'), viewId: identifier, state: extensionJsonSchema }).strict(),
  extensionFileReadRequestSchema,
])
export type RuntimeApiRequest = z.infer<typeof runtimeApiRequestSchema>

export const runtimeEventSchema = z.union([
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('stopped'), id: identifier }).strict(),
  z.object({ kind: z.literal('failed'), error: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('result'), id: identifier, ok: z.literal(true), value: extensionJsonSchema.optional() }).strict(),
  z.object({ kind: z.literal('result'), id: identifier, ok: z.literal(false), error: z.string().max(2000) }).strict(),
])
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>
export type RuntimeInvocation =
  | { kind: 'shutdown'; id: string }
  | { kind: 'command'; id: string; commandId: string }
  | { kind: 'request'; id: string; name: string; input: ExtensionJson; view: { id: string; instanceId: string } }

export type RuntimeStatus = {
  extensionId: string
  revision: string
  state: 'starting' | 'ready' | 'stopped' | 'failed'
  error?: string
}

// State pushes and the initial snapshot can cross in IPC. A monotonically
// increasing sequence within one attached runtime lets the view discard an older
// snapshot instead of rolling its displayed state back after a newer push.
export type RuntimeViewSnapshot = { sequence: number; state?: ExtensionJson }
export type RuntimeChange =
  | { kind: 'status'; status: RuntimeStatus }
  | { kind: 'view'; extensionId: string; revision: string; viewId: string; snapshot: RuntimeViewSnapshot }
export type RuntimeViewEvent =
  | { kind: 'state'; connectionId: string; snapshot: RuntimeViewSnapshot }
  | { kind: 'closed'; connectionId: string; error: string }

const installationFields = { extensionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), revision: z.string().min(1).max(256) }
const connectionId = z.string().uuid()
export const runtimeHostRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('command'), ...installationFields, commandId: identifier }).strict(),
  z.object({ method: z.literal('view.attach'), ...installationFields, connectionId, viewId: identifier }).strict(),
  z.object({ method: z.literal('view.request'), connectionId, name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), input: extensionJsonSchema }).strict(),
  z.object({ method: z.literal('view.detach'), connectionId }).strict(),
  z.object({ method: z.literal('service'), ...installationFields, request: extensionServiceRequestSchema }).strict(),
])
export type RuntimeHostRequest = z.infer<typeof runtimeHostRequestSchema>
