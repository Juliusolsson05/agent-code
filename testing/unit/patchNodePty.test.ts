import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error The patch is plain Node ESM on purpose: it runs from
// `postinstall`, before any TypeScript tooling exists in a fresh checkout.
import { PATCHED_SHA256, PRISTINE_SHA256, patchPtyFile, patchPtySource } from '../../scripts/patch-node-pty.mjs'

// WHY the committed fixture and not node_modules/node-pty/src/unix/pty.cc:
// once postinstall has run, the installed copy IS the patched file. The
// patch's real input only exists on a fresh install, so the byte-exact
// published 1.1.0 source is kept under testing/fixtures (see its README).
const PRISTINE = readFileSync(join(__dirname, '../fixtures/node-pty-1.1.0/pty.cc'), 'utf8')

// Extracts the macOS pty_posix_spawn definition, so assertions look at the
// function the leak lives in and not at a comment or another platform.
function macSpawnFunction(source: string): string {
  const start = source.indexOf('static void\npty_posix_spawn(char** argv, char** env,\n                const struct termios *termp,\n                const struct winsize *winp,\n                int* master,\n                pid_t* pid,\n                std::string* err) {')
  const legacy = source.indexOf('static void\npty_posix_spawn(char** argv, char** env,\n                const struct termios *termp,\n                const struct winsize *winp,\n                int* master,\n                pid_t* pid,\n                int* err) {')
  const at = start !== -1 ? start : legacy
  expect(at).not.toBe(-1)
  return source.slice(at, source.indexOf('\n#endif', at))
}

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function tempCopy(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'patch-node-pty-'))
  const file = join(dir, 'pty.cc')
  writeFileSync(file, content)
  return file
}

describe('node-pty 1.1.0 /dev/ptmx leak patch (#1437)', () => {
  it('the fixture is the exact published 1.1.0 source the patch recognises', async () => {
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(PRISTINE).digest('hex')).toBe(PRISTINE_SHA256)
  })

  it('the unpatched spawn never closes low_fds[0] or the parent slave (the leak itself)', () => {
    // Pins the diagnosis against the real source: the cleanup counts down to
    // 1, so index 0 (the one fd opened whenever stdio is open) leaks, and no
    // close(slave) exists at all.
    const fn = macSpawnFunction(PRISTINE)
    expect(fn).toContain('for (; count > 0; count--) {\n    close(low_fds[count]);')
    expect(fn).not.toContain('close(slave)')
  })

  it('closes every opened low_fds entry, including index 0, and the parent slave', () => {
    const fn = macSpawnFunction(patchPtySource(PRISTINE))
    expect(fn).not.toContain('count--')
    expect(fn).toContain('for (size_t i = 0; i <= count && i < 3; i++) {')
    expect(fn).toContain('close(low_fds[i]);')
    expect(fn).toContain('if (slave != -1) {\n    close(slave);')
    // Every early failure must reach `done:` (the only place fds are
    // released); a bare `return` would reintroduce a per-failure leak.
    expect(fn).not.toMatch(/\n\s+return;/)
    // 10 = posix_openpt, grantpt, unlockpt, TIOCPTYGNAME, open(slave),
    // tcsetattr, TIOCSWINSZ and the three posix_spawnattr_set* calls.
    expect(fn.match(/goto done;/g)?.length).toBe(10)
  })

  it('closes the master on a failed spawn and names the failing call', () => {
    const out = patchPtySource(PRISTINE)
    expect(out).toContain('  int master = -1;\n#if defined(__APPLE__)')
    expect(out).toContain('if (!err.empty()) {\n    if (master != -1) {\n      close(master);\n    }\n    throw Napi::Error::New(napiEnv, "posix_spawnp failed: " + err);')
    expect(out).not.toContain('"posix_spawnp failed."')
  })

  it('leaves Linux and every other function byte-identical', () => {
    const out = patchPtySource(PRISTINE)
    const forkptyBlock = (s: string) => s.slice(s.indexOf('#else\n  int argc = argv_.Length();'), s.indexOf('Napi::Value PtyOpen'))
    expect(forkptyBlock(out)).toBe(forkptyBlock(PRISTINE))
    // Only the three anchored regions change: the rest matches line for line
    // outside pty_posix_spawn and PtyFork's macOS spawn call.
    expect(out.slice(out.indexOf('Napi::Object init('))).toBe(PRISTINE.slice(PRISTINE.indexOf('Napi::Object init(')))
  })

  it('patches a pristine file once and is a no-op on every later install', () => {
    const file = tempCopy(PRISTINE)
    expect(patchPtyFile(file)).toBe('patched')
    const first = readFileSync(file, 'utf8')
    expect(patchPtyFile(file)).toBe('already-patched')
    expect(readFileSync(file, 'utf8')).toBe(first)
    expect(PATCHED_SHA256).not.toBe(PRISTINE_SHA256)
  })

  it('fails the install on any other pty.cc and leaves it untouched', () => {
    // A different node-pty must never be skipped silently: that is how the
    // leak would come back unnoticed after a version change.
    const other = PRISTINE.replace('Copyright (c) 2017, Daniel Imms', 'Copyright (c) 2018, Daniel Imms')
    const file = tempCopy(other)
    expect(() => patchPtyFile(file)).toThrow(/unexpected pty\.cc/)
    expect(readFileSync(file, 'utf8')).toBe(other)
  })
})
