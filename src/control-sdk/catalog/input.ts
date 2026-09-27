import { z } from 'zod'

// The provider terminal composer and Agent Code's draft are separate owners.
// No current provider port proves the full native draft, so absence of a probe
// must remain unknown, never an empty string inferred from an xterm textarea.
export const nativeInputOutput = z.object({ sessionId: z.string(), sessionRunId: z.string().nullable(),
  backendPresent: z.boolean(), nativeDraft: z.object({ state: z.enum(['unknown', 'occupied']), text: z.null(), reason: z.string(),
    // #1350: true while the composer can hold only Agent Code's own stranded
    // delivery write, which the next delivery clears. Distinguishes our
    // leftover from a human draft for a caller that sees `occupied`.
    strandedDelivery: z.boolean().default(false) }),
  inputReady: z.boolean().nullable(), readinessReason: z.string().nullable().default(null) })
