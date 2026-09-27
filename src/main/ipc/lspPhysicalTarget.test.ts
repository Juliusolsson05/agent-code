import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const { lspPhysicalTargetAssertion } = await import('./lsp.js')

// #1268 review A's real-filesystem probe: authorize `src/a.ts` inside the root,
// then swap `src` for a symlink to an outside directory holding its own
// `a.ts`. The lexical path is unchanged, but it now names an escaped file.
let base = ''
afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }) })

async function layout() {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lsp-toctou-')))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export const inside = 1\n')
  await writeFile(join(outside, 'a.ts'), 'export const secret = 1\n')
  return { root, outside }
}

it('passes while the authorized file is still inside the root', async () => {
  const { root } = await layout()
  await expect(lspPhysicalTargetAssertion({ workspaceRoot: root, filePath: join('src', 'a.ts') })!()).resolves.toBeUndefined()
})

it('refuses once a directory on the path was swapped for a symlink outside the root', async () => {
  const { root, outside } = await layout()
  const assertion = lspPhysicalTargetAssertion({ workspaceRoot: root, filePath: join('src', 'a.ts') })!
  await rename(join(root, 'src'), join(root, 'src-moved'))
  await symlink(outside, join(root, 'src'))
  await expect(assertion()).rejects.toThrow(/escapes project root/)
})

it('refuses a leaf that became a symlink, even to a file inside the root', async () => {
  const { root } = await layout()
  const assertion = lspPhysicalTargetAssertion({ workspaceRoot: root, filePath: join('src', 'a.ts') })!
  await writeFile(join(root, 'src', 'b.ts'), 'export const other = 1\n')
  await rm(join(root, 'src', 'a.ts'))
  await symlink(join(root, 'src', 'b.ts'), join(root, 'src', 'a.ts'))
  await expect(assertion()).rejects.toThrow(/symbolic links/)
})

it('has nothing to check for a pathless (virtual) document', () => {
  expect(lspPhysicalTargetAssertion({ workspaceRoot: '/repo', filePath: null })).toBeUndefined()
})
