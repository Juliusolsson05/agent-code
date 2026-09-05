import { z } from 'zod'

// The provider terminal composer and Agent Code's draft are separate owners.
// No current provider port proves the full native draft, so absence of a probe
// must remain unknown, never an empty string inferred from an xterm textarea.
export const nativeInputOutput = z.object({ sessionId: z.string(), sessionRunId: z.string().nullable(),
  backendPresent: z.boolean(), nativeDraft: z.object({ state: z.literal('unknown'), text: z.null(), reason: z.string() }),
  inputReady: z.boolean().nullable() })
