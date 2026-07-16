import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const EXTRACT = join(REPO_ROOT, 'scripts/extract-rendering-fixtures.mjs')
const AUDIT = join(REPO_ROOT, 'scripts/audit-rendering-fixture.mjs')

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The audit intentionally shells through the canonical TypeScript
    // sensitive-key gate. A generous buffer makes the helper reflect the CLI's
    // contract rather than imposing a second, test-only output ceiling.
    maxBuffer: 32 * 1024 * 1024,
  })
}

describe('rendering fixture evidence tools', () => {
  it('extracts the declared patch milestone before apply_patch has streamed', () => {
    const out = mkdtempSync(join(tmpdir(), 'agent-code-render-fixture-'))
    try {
      const bundle = join(
        REPO_ROOT,
        'testing/fixtures/debug-bundles/live-prefix-unified-patch',
      )
      const result = runNode([EXTRACT, '--bundle', bundle, '--out', out])
      expect(result.status, result.stderr || result.stdout).toBe(0)

      const fixture = JSON.parse(
        readFileSync(join(out, 'live-prefix-unified-patch.json'), 'utf8'),
      ) as {
        input: {
          liveToolInputPrefixes: Array<{
            stage: string
            toolUseId: string
            inputJsonSoFar: string
          }>
        }
      }

      const prefixes = fixture.input.liveToolInputPrefixes
      expect(prefixes.map(prefix => prefix.stage)).toEqual([
        'first-prefix',
        'declared-patch-literal',
        'tool-invocation:apply_patch',
      ])
      const declared = prefixes.find(prefix => prefix.stage === 'declared-patch-literal')
      expect(declared?.toolUseId).toBe('codex-live-patch')
      expect(declared?.inputJsonSoFar).toContain('*** Begin Patch')
      expect(declared?.inputJsonSoFar).not.toContain('tools.apply_patch')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('audits provider-shaped operations into user-facing families', () => {
    const fixture = join(
      REPO_ROOT,
      'testing/fixtures/feed-presentation/operation-families.json',
    )
    const fixtureData = JSON.parse(readFileSync(fixture, 'utf8')) as {
      operations: Array<{
        id?: string
        callId?: string
        callID?: string
        toolUseId?: string
        expectedFamily: string
      }>
    }
    const result = runNode([AUDIT, '--json', fixture])
    expect(result.status, result.stderr || result.stdout).toBe(0)

    const report = JSON.parse(result.stdout) as {
      verdict: string
      operations: Array<{
        provider: string
        id: string
        family: string
        stages: string[]
      }>
      operationFamilies: Record<string, number>
    }
    const byId = new Map(report.operations.map(operation => [operation.id, operation]))

    expect(report.verdict).toBe('LIKELY_SAFE')
    expect(byId.get('codex-live-patch')).toMatchObject({
      provider: 'codex',
      family: 'file-change',
      stages: ['declared-patch-literal'],
    })
    for (const operation of fixtureData.operations) {
      const id = operation.id ?? operation.callId ?? operation.callID ?? operation.toolUseId
      if (!id) throw new Error('fixture operation lacks an id')
      expect(byId.get(id)?.family, id).toBe(operation.expectedFamily)
    }
    expect(Object.keys(report.operationFamilies).sort()).toEqual([
      'code-intelligence',
      'collaboration',
      'command',
      'file-change',
      'generic',
      'image',
      'mcp',
      'notebook',
      'preparing',
      'question',
      'read',
      'search',
      'skill-workflow',
      'task-plan',
      'terminal-interaction',
      'web',
      'workspace',
    ])
  }, 30_000)

  it('flushes JSON reports larger than the first stdout buffer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-code-large-audit-'))
    try {
      const fixture = join(dir, 'large-redacted.json')
      // Runtime generation keeps the committed fixture tiny while protecting
      // a real CLI failure mode: process.exit() used to cut JSON output at an
      // exact 64 KiB when stdout was a pipe, so machine consumers saw an
      // unterminated string instead of the report.
      writeFileSync(
        fixture,
        JSON.stringify({
          meta: { note: 'generated redacted output-flush fixture' },
          operations: Array.from({ length: 900 }, (_, index) => ({
            provider: 'codex',
            type: 'function_call',
            callId: `call-${index}`,
            name: 'exec_command',
            argumentsJson: JSON.stringify({ cmd: `printf redacted-${index}` }),
          })),
        }),
      )

      const result = runNode([AUDIT, '--json', fixture])
      expect(result.status, result.stderr || result.stdout.slice(-500)).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(65_536)
      const report = JSON.parse(result.stdout) as { operations: unknown[] }
      expect(report.operations).toHaveLength(900)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('never copies plaintext command input into its machine report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-code-private-command-audit-'))
    try {
      const fixture = join(dir, 'command.json')
      // Long enough to enter the audit's large-string inventory too. The same
      // secret used to leak through both `commands[].preview` and
      // `largeStrings[].preview`, so the regression must exercise both paths.
      const privatePayload = `ULTRA_PRIVATE_COMMAND_PAYLOAD_9Z_${'x'.repeat(10_000)}`
      writeFileSync(
        fixture,
        JSON.stringify({
          provider: 'codex',
          type: 'function_call',
          callId: 'private-command',
          name: 'exec_command',
          argumentsJson: JSON.stringify({ cmd: `printf ${privatePayload}` }),
        }),
      )

      const result = runNode([AUDIT, '--json', fixture])
      expect(result.status, result.stderr || result.stdout).toBe(0)
      // Paths, hashes, lengths, and operation families are sufficient audit
      // evidence. Echoing the command would turn a safety gate into a second
      // secret-distribution channel through CI logs and copied JSON reports.
      expect(result.stdout).not.toContain(privatePayload)
      const report = JSON.parse(result.stdout) as {
        commands: Array<Record<string, unknown>>
      }
      expect(report.commands[0]).toMatchObject({
        operationId: 'private-command',
        inputLength: expect.any(Number),
        hash: expect.any(String),
      })
      expect(report.commands[0]).not.toHaveProperty('preview')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never re-emits untrusted metadata while reporting its audit evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-code-private-meta-audit-'))
    try {
      const fixture = join(dir, 'metadata.json')
      const privateNote = 'ULTRA_PRIVATE_FIXTURE_NOTE_7Q'
      const privateSession = 'ULTRA_PRIVATE_SESSION_ID_8R'
      const privateCredential = 'ULTRA_PRIVATE_API_KEY_9S'
      const privateProvider = 'ULTRA_PRIVATE_PROVIDER_VALUE_0T'
      const privatePath = '/Users/ultra-private-user/.ssh/id_ultra_private'
      writeFileSync(
        fixture,
        JSON.stringify({
          meta: {
            kind: 'codex',
            provider: privateProvider,
            note: privateNote,
            sessionId: privateSession,
            projectDir: privatePath,
            api_key: privateCredential,
          },
          input: { file_path: privatePath },
        }),
      )

      const jsonResult = runNode([AUDIT, '--json', fixture])
      // `api_key` deliberately moves the verdict to REVIEW. The important
      // invariant is that detecting the unsafe field cannot publish its value
      // through the report that a reviewer pastes into CI or an issue.
      expect(jsonResult.status, jsonResult.stderr || jsonResult.stdout).toBe(2)
      expect(jsonResult.stdout).not.toContain(privateNote)
      expect(jsonResult.stdout).not.toContain(privateSession)
      expect(jsonResult.stdout).not.toContain(privateCredential)
      expect(jsonResult.stdout).not.toContain(privateProvider)
      expect(jsonResult.stdout).not.toContain(privatePath)
      const report = JSON.parse(jsonResult.stdout) as {
        meta: Record<string, unknown>
      }
      expect(report.meta.kind).toBe('codex')
      expect(report.meta.note).toMatchObject({
        chars: privateNote.length,
        hash: expect.any(String),
      })
      expect(report.meta.sessionId).toMatchObject({
        chars: privateSession.length,
        hash: expect.any(String),
      })
      expect(report.meta.provider).toMatchObject({
        chars: privateProvider.length,
        hash: expect.any(String),
      })
      expect(report.meta).not.toHaveProperty('api_key')

      const humanResult = runNode([AUDIT, fixture])
      expect(humanResult.status, humanResult.stderr || humanResult.stdout).toBe(2)
      expect(humanResult.stdout).not.toContain(privateNote)
      expect(humanResult.stdout).not.toContain(privateSession)
      expect(humanResult.stdout).not.toContain(privateCredential)
      expect(humanResult.stdout).not.toContain(privateProvider)
      expect(humanResult.stdout).not.toContain(privatePath)
      expect(humanResult.stdout).toContain(`note: ${privateNote.length} chars sha=`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
