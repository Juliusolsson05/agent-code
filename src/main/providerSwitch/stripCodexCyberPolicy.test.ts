import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { TranscriptPublication } from './transcriptEngine.js'

const mocks = vi.hoisted(() => ({
  locate: vi.fn(),
  write: vi.fn(),
  sessionId: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000869',
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: mocks.readFile,
  }
})

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider !== 'codex') throw new Error('No transcript engine adapter is registered')
    return {
      provider,
      locate: mocks.locate,
      write: mocks.write,
      sessionId: mocks.sessionId,
    }
  },
}))

import { stripCodexCyberPolicy } from './stripCodexCyberPolicy.js'

const fixture = readFileSync(
  new URL('../../../testing/fixtures/codex-cyber-policy-native-clone/source.jsonl', import.meta.url),
  'utf8',
)

describe('stripCodexCyberPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.locate.mockResolvedValue('/tmp/source.jsonl')
    mocks.readFile.mockResolvedValue(fixture)
    mocks.sessionId.mockImplementation(({ values }: TranscriptPublication) => {
      const payload = values[0]?.payload as { id?: string } | undefined
      return payload?.id ?? 'missing'
    })
    mocks.write.mockResolvedValue('/target/rollout.jsonl')
  })

  it('writes a native clone of the source rollout, not a native-resume reconstruction', async () => {
    const result = await stripCodexCyberPolicy({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })

    expect(mocks.readFile).toHaveBeenCalledWith('/tmp/source.jsonl', 'utf8')
    expect(mocks.write).toHaveBeenCalledOnce()
    const publication = mocks.write.mock.calls[0]?.[1] as TranscriptPublication
    expect(Array.isArray(publication.values)).toBe(true)
    expect(mocks.sessionId).toHaveBeenCalledWith(publication)
    const serialized = JSON.stringify(publication.values)
    expect(serialized).toContain('"type":"agent_message"')
    expect(serialized).toContain('inter_agent_communication_metadata')
    expect(serialized).not.toContain('cyber_policy')
    expect(serialized).not.toContain('call-last')
    expect(result).toEqual({
      provider: 'codex',
      newProviderSessionId: '00000000-0000-4000-8000-000000000869',
      newFilePath: '/target/rollout.jsonl',
    })
  })

  it('rejects a non-Codex provider before reading', async () => {
    await expect(stripCodexCyberPolicy({
      provider: 'claude',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow(/Codex/)
    expect(mocks.locate).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not write when the session has no cyber policy block', async () => {
    mocks.readFile.mockResolvedValueOnce(
      '{"timestamp":"2026-09-10T00:00:00.000Z","type":"session_meta","payload":{"id":"source-session","timestamp":"2026-09-10T00:00:00.000Z","cwd":"/project"}}\n{"timestamp":"2026-09-10T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n',
    )
    await expect(stripCodexCyberPolicy({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow(/No cybersecurity block/)
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
