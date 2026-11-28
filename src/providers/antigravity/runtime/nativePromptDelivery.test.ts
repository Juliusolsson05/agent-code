import { afterEach, expect, it, vi } from 'vitest'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'
import { AntigravityTerminalSession } from './antigravityTerminalSession.js'
import { deliverAntigravityPrompt } from './promptDelivery.js'

let session: AntigravityTerminalSession
afterEach(() => session.stop())

async function setup() {
  session = new AntigravityTerminalSession({ cwd: '/project', cols: 40, rows: 20 })
  const conversation = vi.spyOn(session, 'confirmedConversation').mockReturnValue('pane-conversation')
  const rule = '─'.repeat(40)
  await session.nativeComposer.output('\x1b[?2004h' + rule + '\r\n>\r\n' + rule + '\r\n? for shortcuts\x1b[2A\r\x1b[2C')
  const write = vi.fn<(data: string) => boolean>().mockReturnValue(true)
  const deliver = (prompt: string) => deliverAntigravityPrompt({ session, sessionId: 'pane', write, prompt } satisfies PromptDeliveryIo)
  return { write, deliver, conversation }
}

it('refuses unsupported terminal control bytes before writing any of a generated prompt', async () => {
  const { deliver, write } = await setup()
  expect(await deliver('test\x1b[201~\rnext')).toMatchObject({ ok: false, promptWritten: false, enterWritten: false })
  expect(write).not.toHaveBeenCalled()
})

it('never retries or sends Enter when the pasted text belongs to a previous conversation', async () => {
  const { deliver, write, conversation } = await setup()
  write.mockImplementation(() => { conversation.mockReturnValue('different-conversation'); return true })
  expect(await deliver('first\r\nsecond')).toMatchObject({ ok: false, stage: 'absorption', promptWritten: true, enterWritten: false, retrySafe: false })
  expect(write.mock.calls).toEqual([['\x1b[200~first\nsecond\x1b[201~']])
})

it('reports a lost process before paste as safe to retry', async () => {
  const { deliver, write } = await setup()
  write.mockReturnValue(false)
  expect(await deliver('one')).toMatchObject({ ok: false, code: 'write-failed', promptWritten: false, enterWritten: false, retrySafe: true })
})

it('keeps a native prompt with an app attachment intact for delivery through Agent view', async () => {
  const { write } = await setup()
  const result = await deliverAntigravityPrompt({ session, sessionId: 'pane', write, prompt: 'inspect the image', imagePaths: ['/screenshot.png'] })
  expect(result).toMatchObject({ ok: false, code: 'missing-capability', enterWritten: false, promptWritten: false })
  expect(write).not.toHaveBeenCalled()
})
