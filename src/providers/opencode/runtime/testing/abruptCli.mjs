// Transport fault injection matching OpenCode 1.18.30's write-then-exit
// lifecycle. This is synthetic content, not a recorded personal transcript.
// NODE_OPTIONS preloads it before Node tries to resolve the CLI command name.
import { fstatSync, ftruncateSync, readFileSync, writeSync } from 'node:fs'
import { basename } from 'node:path'

const command = basename(process.argv[1])
const mode = process.env.OPENCODE_FIXTURE_MODE
if (mode === 'failure') {
  writeSync(2, 'fixture command refused')
  process.exit(7)
}
if (mode === 'invalid') {
  writeSync(1, 'PRIVATE_FIXTURE_CONTENT is not JSON')
  process.exit(0)
}
if (mode === 'oversized' || mode === 'oversized-running') {
  // Sparse output tests the existing 256 MiB guard without allocating or
  // physically writing hundreds of MiB in an ordinary regression suite.
  ftruncateSync(1, 256 * 1024 * 1024 + 1)
  if (mode === 'oversized-running') await new Promise(() => setTimeout(() => process.exit(7), 2000))
  process.exit(0)
}
if (mode === 'stderr-overflow') {
  process.stderr.write('fixture diagnostic '.repeat(15000), () => process.exit(7))
  await new Promise(() => {})
}
if (command === 'models') {
  writeSync(1, 'fixture/model-a\nfixture/model-b\n')
  process.exit(0)
}
if (command === 'import') {
  const value = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  writeSync(1, value.info.id)
  process.exit(0)
}
const text = 'fixture text '.repeat(160000)
const sessionID = process.argv[2]
const value = command === 'debug'
  ? { model: 'fixture/model', fixture: text }
  : {
    info: { id: sessionID, directory: process.cwd() },
    messages: [{ info: { id: 'msg_fixture', sessionID, role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text }] }],
    fixtureEnv: process.env.OPENCODE_FIXTURE_VALUE,
    outputMode: fstatSync(1).isFile() ? fstatSync(1).mode & 0o777 : null,
    // Link count of the capture as the running child sees it. Zero means the
    // parent unlinked it before spawn, so no name exists to leave behind.
    outputLinks: fstatSync(1).isFile() ? fstatSync(1).nlink : null,
  }
process.stdout.write(JSON.stringify(value))
process.stdout.write('\n')
process.exit(0)
