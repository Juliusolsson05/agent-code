import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const requiredOutputs = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/remote-client/index.html',
]

const missing = []
for (const output of requiredOutputs) {
  try {
    await access(join(process.cwd(), output))
  } catch {
    missing.push(output)
  }
}

if (missing.length > 0) {
  console.error('The build completed without required application entry points:')
  for (const output of missing) console.error(`- ${output}`)
  process.exitCode = 1
} else {
  console.log('Application build contains every required entry point')
}
