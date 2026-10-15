import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { HermesConnectionService, type SshRunner } from '@main/hermes/service.js'
import { HERMES_PROBE_SCRIPT } from '@shared/hermes/ssh.js'

// SSH access on a Hermes connection, through the service (#1528): what is
// saved, what the probe is asked, and what Settings is told.
//
// Fixtures: the runner replays the REAL probe stdout recorded from a Hermes
// VPS (see src/shared/hermes/ssh.test.ts) and the real OpenSSH stderr of a
// refused key. No ssh process runs here; the runner is the one seam.

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (cipher) => cipher.toString('utf8').slice(4),
}
const RECORDED = 'agent-code-hermes-probe 1\ndocker direct\ncontainer hermes-agent-pjlj-hermes-agent-1 bash /opt/hermes/bin/hermes\nend\n'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function service(runSsh?: SshRunner) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hermes-ssh-'))
  dirs.push(stateDir)
  const instance = new HermesConnectionService({ stateDir, codec, openExternal: () => undefined, runSsh })
  await instance.initialize()
  const added = await instance.add({ name: 'VPS', baseUrl: 'https://hermes.example' })
  const onDisk = async () => JSON.parse(await readFile(join(stateDir, 'hermes', 'connections.json'), 'utf8')).connections[0]
  return { instance, id: added.id, stateDir, onDisk }
}

describe('Hermes SSH access (#1528)', () => {
  it('detect runs the probe over BatchMode ssh with the saved options and saves the one container found', async () => {
    const runSsh = vi.fn<SshRunner>(async () => ({ code: 0, stdout: RECORDED, stderr: '' }))
    const { instance, id, onDisk } = await service(runSsh)
    await instance.setSshAccess(id, { destination: 'root@203.0.113.7', port: '2222', identityFile: '~/.ssh/hermes' })

    const detection = await instance.detectHermes(id)

    expect(detection).toMatchObject({ ok: true, message: 'Hermes runs in container hermes-agent-pjlj-hermes-agent-1.' })
    expect(runSsh).toHaveBeenCalledWith(
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-p', '2222', '-i', '~/.ssh/hermes', 'root@203.0.113.7', 'sh', '-s'],
      HERMES_PROBE_SCRIPT,
    )
    expect((await onDisk()).ssh).toEqual({
      destination: 'root@203.0.113.7',
      port: 2222,
      identityFile: '~/.ssh/hermes',
      hermes: { kind: 'docker', container: 'hermes-agent-pjlj-hermes-agent-1', shell: 'bash', sudo: false },
    })
    expect(instance.shellCommand(id, 'hermes')).toEqual({ ok: true, name: 'VPS', command: "ssh -t -p 2222 -i '~/.ssh/hermes' root@203.0.113.7 docker exec -it hermes-agent-pjlj-hermes-agent-1 bash" })
  })

  it('a refused key is a sentence for Settings, not a thrown IPC error, and nothing is saved', async () => {
    const { instance, id, onDisk } = await service(async () => ({ code: 255, stdout: '', stderr: 'root@203.0.113.7: Permission denied (publickey,password).\n' }))
    await instance.setSshAccess(id, { destination: 'root@203.0.113.7' })
    const detection = await instance.detectHermes(id)
    expect(detection.ok).toBe(false)
    expect(detection.message).toMatch(/^root@203\.0\.113\.7: Permission denied \(publickey,password\)\. .*ssh-add/)
    expect((await onDisk()).ssh).toEqual({ destination: 'root@203.0.113.7' })
  })

  it('an answer about the OLD server never lands on a destination edited while the probe ran', async () => {
    let finish!: () => void
    const { instance, id, onDisk } = await service(() => new Promise((resolve) => { finish = () => resolve({ code: 0, stdout: RECORDED, stderr: '' }) }))
    await instance.setSshAccess(id, { destination: 'old-vps' })
    const detecting = instance.detectHermes(id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await instance.setSshAccess(id, { destination: 'new-vps' })
    finish()
    await detecting
    expect((await onDisk()).ssh).toEqual({ destination: 'new-vps' })
  })

  it('after an ambiguous detection the user can choose the server itself (review of #1530)', async () => {
    const both = 'agent-code-hermes-probe 1\nhost /usr/bin/hermes\ndocker direct\ncontainer hermes-agent-pjlj-hermes-agent-1 bash /opt/hermes/bin/hermes\nend\n'
    const { instance, id } = await service(async () => ({ code: 0, stdout: both, stderr: '' }))
    await instance.setSshAccess(id, { destination: 'vps' })
    expect(await instance.detectHermes(id)).toMatchObject({ ok: false, candidates: ['hermes-agent-pjlj-hermes-agent-1'] })
    expect(instance.shellCommand(id, 'hermes')).toMatchObject({ ok: false })
    await instance.setSshAccess(id, { destination: 'vps', container: '', onHost: true })
    expect(instance.shellCommand(id, 'hermes')).toEqual({ ok: true, name: 'VPS', command: 'ssh -t vps' })
  })

  it('a probe that started before ANY edit of the route never lands, even on the same destination (review of #1530)', async () => {
    let finish!: () => void
    const { instance, id, onDisk } = await service(() => new Promise((resolve) => { finish = () => resolve({ code: 0, stdout: RECORDED, stderr: '' }) }))
    await instance.setSshAccess(id, { destination: 'vps', port: '22' })
    const detecting = instance.detectHermes(id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    // Another window: same name, another port (possibly another machine), and a container typed by hand.
    await instance.setSshAccess(id, { destination: 'vps', port: '2222', container: 'manually-selected' })
    finish()
    await detecting
    expect((await onDisk()).ssh).toEqual({ destination: 'vps', port: 2222, hermes: { kind: 'docker', container: 'manually-selected', shell: 'bash', sudo: false } })
  })

  it('a detected shell survives re-saving the same container only on the same route', async () => {
    const shOnly = 'agent-code-hermes-probe 1\ndocker direct\ncontainer hermes sh /usr/local/bin/hermes\nend\n'
    const { instance, id, onDisk } = await service(async () => ({ code: 0, stdout: shOnly, stderr: '' }))
    await instance.setSshAccess(id, { destination: 'vps' })
    await instance.detectHermes(id)
    await instance.setSshAccess(id, { destination: 'vps', container: 'hermes' })
    expect((await onDisk()).ssh.hermes).toEqual({ kind: 'docker', container: 'hermes', shell: 'sh', sudo: false })
    await instance.setSshAccess(id, { destination: 'vps', port: '2200', container: 'hermes' })
    expect((await onDisk()).ssh.hermes.shell).toBe('bash')
  })

  it('a hung server gets its own sentence, and a removed connection is an answer, not a throw', async () => {
    const { instance, id } = await service(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }))
    await instance.setSshAccess(id, { destination: 'vps' })
    expect((await instance.detectHermes(id)).message).toMatch(/did not finish answering within 30 seconds/)
    await instance.remove(id)
    expect(await instance.detectHermes(id)).toEqual({ ok: false, message: 'This Hermes connection no longer exists.' })
  })

  it('refuses an unsafe draft and removes SSH access on null', async () => {
    const { instance, id, onDisk } = await service()
    await expect(instance.setSshAccess(id, { destination: '-oProxyCommand=touch /tmp/pwned' })).rejects.toThrow(/SSH destination/)
    await instance.setSshAccess(id, { destination: 'vps' })
    await instance.setSshAccess(id, null)
    expect((await onDisk()).ssh).toBeUndefined()
    expect(instance.shellCommand(id, 'vps')).toEqual({ ok: false, error: 'Set up SSH access for "VPS" in Settings → Hermes.' })
  })

  it('a hand-edited, unsafe ssh block is dropped on load without losing the connection', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hermes-ssh-'))
    dirs.push(stateDir)
    await mkdir(join(stateDir, 'hermes'), { recursive: true })
    await writeFile(join(stateDir, 'hermes', 'connections.json'), JSON.stringify({
      version: 1,
      connections: [
        { id: 'a', name: 'Edited', baseUrl: 'https://a.example', createdAt: 1, ssh: { destination: '-oProxyCommand=x' } },
        { id: 'b', name: 'Fine', baseUrl: 'https://b.example', createdAt: 2, ssh: { destination: 'vps', hermes: { kind: 'docker', container: 'hermes', shell: 'sh', sudo: true } } },
      ],
    }))
    const instance = new HermesConnectionService({ stateDir, codec, openExternal: () => undefined })
    await instance.initialize()
    expect(instance.get('a')).toMatchObject({ name: 'Edited', baseUrl: 'https://a.example' })
    expect(instance.get('a')?.ssh).toBeUndefined()
    expect(instance.shellCommand('b', 'hermes')).toMatchObject({ ok: true, command: 'ssh -t vps sudo docker exec -it hermes sh' })
  })
})
