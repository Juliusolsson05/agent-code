// Phase 1 smoke test: prove cc-shell can resolve and use the
// agent-voice-dictation package without any actual network round-trip.
//
// Why a structural smoke test instead of a real Deepgram call:
//   - No API key in this dev sandbox, no fixture audio in cc-shell's repo.
//   - We want a fast, deterministic gate that catches the breakage modes
//     this integration is most likely to hit: misnamed exports, broken
//     subpath resolution, types that drift between the two repos. Real
//     network tests belong in flow-electron's live-providers suite, not
//     here — cc-shell is a consumer, not a provider gateway.
//
// What this verifies:
//   1. cc-shell's main-process tsx can import 'agent-voice-dictation'
//      and the controller wrapping it.
//   2. Both subpath exports we rely on resolve (composer + env).
//   3. listSelectableProviders() agrees with the package's support map
//      (catches the case where the package quietly disables a provider
//      and cc-shell's UI keeps offering it).
//   4. The Deepgram streaming singleton constructs without throwing.
//
// Run with: npm run test:dictation

import { wrapWithSttTag } from 'agent-voice-dictation/composer'
import { parseDotEnv } from 'agent-voice-dictation/env'
import {
  STT_PROVIDER_SUPPORT,
  type SpeechProviderId,
} from 'agent-voice-dictation'

import {
  deepgramStreaming,
  listSelectableProviders,
  transcribeBatch,
  type DictationBatchInput,
  type DictationBatchOutcome,
} from '../src/main/dictation/index.js'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}`, detail ?? '')
  }
}

console.log('\nagent-voice-dictation integration smoke test\n')

console.log('package subpath exports:')
check('composer subpath: wrapWithSttTag is callable', typeof wrapWithSttTag === 'function')
check('composer subpath: wraps as expected', wrapWithSttTag('hello').includes('<stt'))
check('env subpath: parseDotEnv is callable', typeof parseDotEnv === 'function')
const parsed = parseDotEnv('FOO=bar\n# comment\nBAZ="qux"')
check('env subpath: parses simple kv', parsed.FOO === 'bar' && parsed.BAZ === 'qux')

console.log('\ncontroller surface:')
check('transcribeBatch is exported', typeof transcribeBatch === 'function')
check('deepgramStreaming is exported', typeof deepgramStreaming === 'function')
check('listSelectableProviders is exported', typeof listSelectableProviders === 'function')

console.log('\nprovider registry agreement:')
const exposedByController = new Set(listSelectableProviders())
const expectedFromPackage = new Set(
  (Object.keys(STT_PROVIDER_SUPPORT) as SpeechProviderId[])
    .filter(id => STT_PROVIDER_SUPPORT[id].selectable),
)
check(
  'controller and package agree on selectable providers',
  exposedByController.size === expectedFromPackage.size
    && [...exposedByController].every(id => expectedFromPackage.has(id)),
  { controller: [...exposedByController], package: [...expectedFromPackage] },
)
check(
  'at least one provider is selectable',
  exposedByController.size >= 1,
)

console.log('\nstreaming provider construction:')
let streaming: ReturnType<typeof deepgramStreaming>
try {
  streaming = deepgramStreaming()
  check('Deepgram streaming singleton constructed', true)
} catch (err) {
  check('Deepgram streaming singleton constructed', false, err)
  process.exit(1)
}
check('streaming.start is callable', typeof streaming.start === 'function')
check('streaming.stop is callable', typeof streaming.stop === 'function')
check('streaming.cancel is callable', typeof streaming.cancel === 'function')

// Type-level check: confirm the discriminated-union outcome shape compiles.
// This block never runs at the type level if the union has changed
// incompatibly; tsx will refuse to load the file.
const _typeCheck: DictationBatchOutcome = { kind: 'no-speech' }
void _typeCheck
const _inputCheck: DictationBatchInput = {
  provider: 'deepgram',
  apiKey: 'placeholder',
  audio: new ArrayBuffer(0),
}
void _inputCheck

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
