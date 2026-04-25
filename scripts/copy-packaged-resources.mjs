import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const resources = [
  {
    from: 'packages/claude-code-headless/src/testing/proxy-testing/mitmAddon.py',
    to: 'out/main/mitmAddon.py',
  },
]

for (const resource of resources) {
  const from = resolve(resource.from)
  const to = resolve(resource.to)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
}

