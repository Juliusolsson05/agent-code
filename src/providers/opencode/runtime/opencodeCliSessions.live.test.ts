import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeNativeResumeProjector, codexNativeResumeProjector, decodeOpencodeConversation, opencodeNativeResumeProjector } from 'agent-transcript-parser'
import { exportOpencodeSession } from './opencodeCliSessions.js'

// Explicit read-only native verification. No source/target sessions are
// modified, and no personal transcript values or source IDs become fixtures.
it('exports an opted-in large native OpenCode session completely through the production capture boundary', async context => {
  const sessionId = process.env.OPENCODE_EXPORT_SESSION_ID
  if (!sessionId) context.skip('Set OPENCODE_EXPORT_SESSION_ID to opt into a large native session export')
  const binary = process.env.OPENCODE_BINARY ?? join(homedir(), '.opencode', 'bin', 'opencode')
  if (!existsSync(binary)) context.skip('Installed OpenCode CLI unavailable')
  const value = await exportOpencodeSession({ binary, cwd: process.env.OPENCODE_EXPORT_CWD ?? process.cwd() }, sessionId!)
  const info = value.info as { id?: string } | undefined
  expect(info?.id === sessionId, 'export identity matches the requested native session').toBe(true)
  expect(Array.isArray(value.messages)).toBe(true)
  const bytes = Buffer.byteLength(JSON.stringify(value))
  expect(bytes, 'fixture source must exceed the observed pipe truncation boundary').toBeGreaterThan(128 * 1024)
  const conversation = decodeOpencodeConversation(value)
  expect(conversation.entries.length).toBeGreaterThan(0)
  // Exercise the real conversion hub with the previously failing native
  // export, but do NOT publish target sessions or execute any imported tools.
  const target = {
    cwd: process.env.OPENCODE_EXPORT_CWD ?? process.cwd(),
    targetSessionId: '00000000-0000-4000-8000-000000000001',
    now: '2026-09-09T00:00:00.000Z', version: 'fixture', cliVersion: 'fixture',
    model: 'fixture-model', modelProvider: 'fixture-provider',
  }
  for (const projector of [claudeNativeResumeProjector, codexNativeResumeProjector, opencodeNativeResumeProjector]) {
    const projection = projector.projectNativeResume(conversation, target)
    expect(projection.values.length, `${projector.provider} native projection is nonempty`).toBeGreaterThan(0)
    expect(projection.report.counts.preserved, `${projector.provider} retained native conversation content`).toBeGreaterThan(0)
  }
  console.info(`Native export verified: ${bytes} JSON bytes, ${(value.messages as unknown[]).length} messages; identity matches.`)
}, 60000)
