import { readFile } from 'node:fs/promises'

import {
  classifyClaudeDocument,
  classifyCodexDocument,
  decodeClaudeConversation,
  decodeCodexConversation,
  decodeJsonl,
} from 'agent-transcript-parser'
import type { ConversationDocument } from 'agent-transcript-parser'

// Decode a Stage 0 observed-sequence fixture into a ConversationDocument, for
// host tests that need a real transcript instead of a hand-written literal.
//
// WHY the host owns a loader at all, when the parser already ships one
// (`packages/agent-transcript-parser/testing/engine/fixtureConversations.ts`):
// that file lives outside the submodule's `src/` tree, which is the only part
// of the package this repo's tsconfig and Vitest alias map resolve. Importing
// it from here would mean either widening the app's typecheck include to the
// package's test-support directory or reaching across the submodule boundary
// with a relative path — both of which make an app test depend on the parser's
// private test layout. Reading the committed `source.jsonl` and decoding it
// through the package's PUBLIC entry points instead couples us only to what the
// parser already promises its consumers.
//
// WHY the parser is real here while the transcript engine stays mocked: the
// thing under test is the host's transaction policy — which plan outcome it
// asks for, whether it ever spends a source turn, what it reports. Faking the
// planner would let the host agree with a planner that does not exist; faking
// the filesystem/adapter layer keeps the test off disk. So the decode path is
// real from bytes to ConversationDocument, and everything after projection is
// a mock.
//
// SIZE WARNING (census caveat 1,
// docs/decomposition/evidence/provider-switch/census.md): these fixtures are
// value-redacted, which collapses them to 0.3–2.4 % of the real byte totals —
// every private scalar becomes the string "fixture text". Their ENTRY COUNTS
// and structure are faithful; their CHARACTER COUNTS are not. Never write a
// test that hard-codes a real-world budget (581,400 for Codex, 2,250,000 for a
// 1M Claude target) and expects a fixture to exceed it. Derive the budget from
// `estimateConversationCharacters(conversation)` instead, or the assertion is
// really testing the redactor.

const SEQUENCES = new URL(
  '../../../../packages/agent-transcript-parser/fixtures/evidence/observed-sequences/',
  import.meta.url,
)

export async function loadFixtureConversation(
  caseId: string,
  provider: 'claude' | 'codex',
): Promise<ConversationDocument> {
  const raw = decodeJsonl(
    await readFile(new URL(`${caseId}/source.jsonl`, SEQUENCES), 'utf8'),
  )
  return provider === 'claude'
    ? decodeClaudeConversation(classifyClaudeDocument(raw).records)
    : decodeCodexConversation(classifyCodexDocument(raw).records)
}
