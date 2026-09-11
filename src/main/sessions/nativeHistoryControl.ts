import { z } from 'zod'
import { defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import type { ConversationService } from '@main/conversations/service'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'

const provider = z.enum(['claude', 'codex', 'opencode'])
const identity = z.object({ provider, cwd: z.string().min(1).describe('Native session working directory, not a project title.'),
  nativeSessionId: z.string().min(1).describe('Provider-native ID from nativeHistory.list or agents.lifecycleRead; not an Agent Code session ID.') })
const prompt = z.object({ address: z.object({ provider, line: z.number(), sessionId: z.string().nullable(), uuid: z.string().nullable().optional() }),
  text: z.string(), totalChars: z.number(), timestamp: z.string().nullable() })
const session = z.object({ nativeSessionId: z.string(), summary: z.string(), lastModified: z.number(), fileSize: z.number(),
  cwd: z.string().nullable(), customTitle: z.string().nullable(), firstPrompt: z.string().nullable(), gitBranch: z.string().nullable() })

type CatalogRow = Awaited<ReturnType<ConversationService['list']>>['rows'][number]

// Catalogs are served by the same conversation service as the in-app picker
// (docs/decomposition/conversations.md, D8), so an external operator and the
// user see the same rows in the same order: every provider including
// OpenCode, every worktree of a cwd's repository, ordered by the user's last
// activity. Output schemas are kept so existing operators keep parsing; the
// coverage block now reports the truth (scope-bounded and exhaustive within
// the scope) instead of the old 400-candidate budget, and `fileSize` is a
// constant zero because the catalog does not stat transcripts to list them.
export function nativeHistoryControlCapabilities(service: ConversationService) {
  const rowToSession = (row: CatalogRow) => ({
    nativeSessionId: row.nativeId, summary: row.label.slice(0, 4000), lastModified: row.lastUserActivityAt, fileSize: 0,
    cwd: row.cwd || null, customTitle: row.agentCodeTitle, firstPrompt: row.firstPrompt?.slice(0, 4000) ?? null, gitBranch: row.gitBranch,
  })
  return [
    defineCapability({ id: 'nativeHistory.search', title: 'Search historical conversation prompts', execution: 'main', effect: 'read',
      description: 'Search past conversations by title, agent name and user-prompt text across Claude, Codex and OpenCode, including conversations not open in Agent Code. Scoped to the repository family of cwd when given (every worktree of it), otherwise everywhere. Returns provider-native IDs, cwd, the last user-activity timestamp and the matched snippet. Use nativeHistory.prompts for exact rewind addresses and agents.resume for the chosen native ID/cwd; never guess a missing cwd.',
      input: z.object({ query: z.string().trim().min(1).max(2000), cwd: z.string().min(1).optional(), resultLimit: z.number().int().min(1).max(800).default(100), ...pageInput }).strict(),
      output: pageSchema(z.object({ provider, nativeSessionId: z.string(), cwd: z.string().nullable(), lastModified: z.number(), summary: z.string(), matchCount: z.number(), prompts: z.array(z.object({ text: z.string(), totalChars: z.number(), timestamp: z.number().nullable() })) })).extend({ coverage: z.object({ providers: z.array(z.string()), candidatesPerProvider: z.number(), exhaustive: z.boolean(), possiblyMoreResults: z.boolean() }) }),
      handler: async input => {
        const response = await service.list({ cwd: input.cwd ?? '', scope: input.cwd ? 'repository' : 'everywhere', query: input.query, includeChildren: true, limit: input.resultLimit })
        // Hash full evidence before shortening text, so changing a prompt after
        // its preview boundary cannot silently reuse an old page revision.
        const page = paginate(response.rows, input, `native-search:${input.query}:${input.cwd ?? ''}:${input.resultLimit}`)
        return { ...page, items: page.items.map(row => ({ provider: row.provider, nativeSessionId: row.nativeId, cwd: row.cwd || null, lastModified: row.lastUserActivityAt, summary: row.label.slice(0, 2000), matchCount: row.match ? 1 : 0,
          prompts: row.match ? [{ text: row.match.text.slice(0, 2000), totalChars: row.match.text.length, timestamp: null }] : [] })),
          coverage: { providers: ['claude', 'codex', 'opencode'], candidatesPerProvider: response.total, exhaustive: true, possiblyMoreResults: response.nextCursor !== null } }
      },
    }),
    defineCapability({ id: 'nativeHistory.list', title: 'Find native sessions to resume', execution: 'main', effect: 'read',
      description: 'List past conversations for one provider, newest user activity first, including conversations not open in Agent Code and every worktree of cwd when given. Orchestration children, native subagents and exec runs are included; possiblyTruncated means older rows exist beyond scanLimit. Use agents.resume to open a chosen native identity in an explicit project.',
      input: z.object({ provider, cwd: z.string().min(1).optional(), scanLimit: z.number().int().min(1).max(2000).default(500).describe('Number of recent native records to load before paging; keep fixed for continuation.'), ...pageInput }).strict(),
      output: pageSchema(session).extend({ provider, possiblyTruncated: z.boolean() }),
      handler: async input => {
        const response = await service.list({ cwd: input.cwd ?? '', scope: input.cwd ? 'repository' : 'everywhere', providers: [input.provider], includeChildren: true, limit: input.scanLimit })
        return { ...paginate(response.rows.map(rowToSession), input, `native:${input.provider}:${input.cwd ?? ''}:${input.scanLimit}`), provider: input.provider, possiblyTruncated: response.nextCursor !== null }
      },
    }),
    defineCapability({ id: 'nativeHistory.prompts', title: 'Find exact native rewind addresses', execution: 'main', effect: 'read',
      description: 'Read user prompt addresses from an exact native transcript, newest first, without waking its agent. Uses the native engine, including OpenCode export for a known ID. Text previews are bounded; totalChars reports omitted text. Addresses are opaque source references, not rendered message indexes. Pass an address unchanged to agents.rewind. Source changes invalidate paging; rewind itself revalidates membership and refuses an empty resulting conversation.',
      input: identity.extend({ ...pageInput, query: z.string().default('').describe('Optional case-insensitive substring filter on full prompt text, before previews and paging.'), previewChars: z.number().int().min(0).max(4000).default(1000).describe('Maximum text characters per prompt; zero returns addresses only.') }).strict(),
      output: pageSchema(prompt),
      handler: async input => {
        const prompts = await getHostTranscriptAdapter(input.provider).listPrompts(input.cwd, input.nativeSessionId)
        // Revision includes full text, not only previews: an edited prompt
        // after the preview boundary must invalidate the address catalog too.
        const page = paginate(prompts.filter(prompt => prompt.text.toLowerCase().includes(input.query.toLowerCase())).reverse(), input, `prompts:${input.provider}:${input.cwd}:${input.nativeSessionId}:${input.previewChars}:${input.query}`)
        return { ...page, items: page.items.map(row => ({ ...row, text: row.text.slice(0, input.previewChars), totalChars: row.text.length })) }
      },
    }),
  ]
}
