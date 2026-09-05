import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { getMainProvider } from '@providers/registry.main'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'

const provider = z.enum(['claude', 'codex', 'opencode'])
const identity = z.object({ provider, cwd: z.string().min(1).describe('Native session working directory, not a project title.'),
  nativeSessionId: z.string().min(1).describe('Provider-native ID from nativeHistory.list or agents.lifecycleRead; not an Agent Code session ID.') })
const prompt = z.object({ address: z.object({ provider, line: z.number(), sessionId: z.string().nullable(), uuid: z.string().nullable().optional() }),
  text: z.string(), totalChars: z.number(), timestamp: z.string().nullable() })
const session = z.object({ nativeSessionId: z.string(), summary: z.string(), lastModified: z.number(), fileSize: z.number(),
  cwd: z.string().nullable(), customTitle: z.string().nullable(), firstPrompt: z.string().nullable(), gitBranch: z.string().nullable() })

// Catalogs adapt the same provider registry and transcript engine used by the
// native pickers. In particular, discovery failure is not an empty inventory:
// the current OpenCode registry intentionally cannot enumerate sessions (#773),
// although known native IDs can still be read, resumed and transformed.
export function nativeHistoryControlCapabilities() {
  return [
    defineCapability({ id: 'nativeHistory.list', title: 'Find native sessions to resume', execution: 'main', effect: 'read',
      description: 'List recent provider-native sessions, including conversations not open in Agent Code. Select one provider and optionally an exact cwd. Discovery does not wake agents. The catalog is bounded by scanLimit; possiblyTruncated means older sessions may exist beyond it. OpenCode discovery is currently unsupported (#773), not an empty account. Use agents.resume to open a chosen native identity in an explicit project.',
      input: z.object({ provider, cwd: z.string().min(1).optional(), scanLimit: z.number().int().min(1).max(2000).default(500).describe('Number of recent native records to load before paging; keep fixed for continuation.'), ...pageInput }).strict(),
      output: pageSchema(session).extend({ provider, possiblyTruncated: z.boolean() }),
      handler: async input => {
        const owner = getMainProvider(input.provider)
        if (owner.sessionDiscoveryUnavailableReason) throw new ControlError('unavailable', owner.sessionDiscoveryUnavailableReason)
        if (!input.cwd && !owner.listAllSessions) throw new ControlError('unavailable', 'This provider requires a working directory for discovery')
        const rows = input.cwd ? await owner.listSessions(input.cwd, input.scanLimit) : await owner.listAllSessions!(input.scanLimit)
        const normalized = rows.map(row => ({ nativeSessionId: row.sessionId, summary: row.summary.slice(0, 4000), lastModified: row.lastModified,
          fileSize: row.fileSize, cwd: row.cwd ?? input.cwd ?? null, customTitle: row.customTitle ?? null,
          firstPrompt: row.firstPrompt?.slice(0, 4000) ?? null, gitBranch: row.gitBranch ?? null }))
        return { ...paginate(normalized, input, `native:${input.provider}:${input.cwd ?? ''}:${input.scanLimit}`), provider: input.provider,
          possiblyTruncated: rows.length >= input.scanLimit }
      },
    }),
    defineCapability({ id: 'nativeHistory.prompts', title: 'Find exact native rewind addresses', execution: 'main', effect: 'read',
      description: 'Read user prompt addresses from an exact native transcript, newest first, without waking its agent. Uses the native engine, including OpenCode export for a known ID. Text previews are bounded; totalChars reports omitted text. Addresses are opaque source references, not rendered message indexes. Pass an address unchanged to agents.rewind. Source changes invalidate paging; rewind itself revalidates membership and refuses an empty resulting conversation.',
      input: identity.extend({ ...pageInput, previewChars: z.number().int().min(0).max(4000).default(1000).describe('Maximum text characters per prompt; zero returns addresses only.') }).strict(),
      output: pageSchema(prompt),
      handler: async input => {
        const prompts = await getHostTranscriptAdapter(input.provider).listPrompts(input.cwd, input.nativeSessionId)
        // Revision includes full text, not only previews: an edited prompt
        // after the preview boundary must invalidate the address catalog too.
        const page = paginate(prompts.slice().reverse(), input, `prompts:${input.provider}:${input.cwd}:${input.nativeSessionId}:${input.previewChars}`)
        return { ...page, items: page.items.map(row => ({ ...row, text: row.text.slice(0, input.previewChars), totalChars: row.text.length })) }
      },
    }),
  ]
}
