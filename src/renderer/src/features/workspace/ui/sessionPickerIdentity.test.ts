import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The lock that keeps #96 closed.
//
// #96 was not one bug. It was the same bug re-appearing every time a new
// surface learned to list past sessions: each one reached into the raw listing
// record and invented its own label. The issue named three modals; by the time
// it was picked up there were four, because the command palette had been added
// in the meantime and nobody noticed it was re-solving a solved problem.
//
// So fixing the three surfaces is not enough — without a gate, surface five
// re-opens the issue. This test asserts the RULE rather than the instances:
//
//   a session picker renders identity through SessionPickerRow, and never by
//   reading `.summary`, `.firstPrompt`, or a sliced `.sessionId` itself.
//
// WHY a filesystem scan rather than an ESLint rule or a type-level trick: the
// repo's convention is one narrow boundary test with a clear failure message,
// not a bespoke framework (see src/providers/importBoundaries.test.ts, which
// exists for the same reason). A test is visible in the suite, breaks loudly in
// CI, and needs no new tooling.
//
// WHY it cannot be a type-level ban: `summary` must stay on the wire for search
// ranking and other non-display callers, so the field is legitimately reachable.
// What is forbidden is reaching for it *to build a label*, and that is a usage
// rule, not a shape rule.
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url))
const rendererSrc = resolve(testDir, '../../..')

/** Every surface that lets a user pick a PAST session.
 *
 *  Deliberately NOT included: ViewPromptsModal and RewindToPromptModal. #96
 *  listed both, but they pick a prompt INSIDE an already-open session — they
 *  take a sessionId prop and never display a session identity, because the user
 *  already knows which session they are in. Forcing them through a session-row
 *  component would be a regression dressed up as consistency.
 *
 *  When a new past-session picker is added, add it here. If that feels like a
 *  chore, that is the test working: the alternative is the fifth surface
 *  quietly re-opening #96. */
const SESSION_PICKERS = [
  'features/path-picker/ui/PathPickerModal.tsx',
  'features/command-palette/ui/CommandPalette.tsx',
  'features/workspace/ui/PromptSearchModal.tsx',
] as const

/** Reading a raw listing field to build a display label. Each of these is a
 *  literal line that existed in one of the three surfaces before #96 was
 *  fixed. */
const FORBIDDEN = [
  { pattern: /\.summary\s*\|\|/, why: 'builds a label from a `summary` fallback chain' },
  { pattern: /\{\s*\w+\.summary\s*\}/, why: 'renders `summary` directly as a label' },
  { pattern: /\.sessionId\.slice\(/, why: 'renders a truncated session id as a label' },
  { pattern: /\{\s*\w+\.firstPrompt\s*\}/, why: 'renders `firstPrompt` directly as a label' },
] as const

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(rendererSrc, relativePath), 'utf8')
}

/** Strip comments so the prose in this repo — which quotes the old code
 *  extensively when explaining why it was wrong — cannot fail the test it is
 *  describing. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
}

describe('session pickers share one display identity (#96)', () => {
  it.each(SESSION_PICKERS)('%s renders identity through SessionPickerRow', file => {
    expect(sourceOf(file)).toContain('SessionPickerRow')
  })

  it.each(SESSION_PICKERS)('%s does not build its own session label', file => {
    const code = stripComments(sourceOf(file))
    const violations = FORBIDDEN.filter(rule => rule.pattern.test(code)).map(rule => rule.why)
    expect(
      violations,
      `${file} ${violations.join('; ')}. A past-session label comes from ` +
        '`identity.label` via SessionPickerRow — the ladder in ' +
        '@shared/types/sessionDisplayIdentity decides it once, in main. ' +
        'Deriving one here is how the same conversation ends up with a ' +
        'different name in each picker (#96).',
    ).toEqual([])
  })
})
