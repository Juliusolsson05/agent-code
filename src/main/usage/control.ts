import { z } from 'zod'
import { defineCapability } from '@control-sdk'
import { readUsageSnapshotForTools } from './usageService'

// Return the existing sanitized quota snapshot, never authentication files or
// a second quota estimator. Each provider keeps its independent failure state.
export function usageControlCapabilities() {
  return [defineCapability({ id: 'usage.read', title: 'Read provider usage and quota', execution: 'main', effect: 'read',
    description: 'Read the same sanitized provider quota and spend snapshot as the Usage UI, including fetch time, cache age policy and per-provider errors. Covers Claude, Codex, Grok and OpenCode (z.ai). May contact the providers; force bypasses the normal short cache. Never returns credentials and never treats a provider error as zero usage.',
    input: z.object({ force: z.boolean().default(false) }).strict(), output: z.object({ snapshot: z.json() }),
    handler: async input => ({ snapshot: z.json().parse(await readUsageSnapshotForTools(input)) }),
  })]
}
