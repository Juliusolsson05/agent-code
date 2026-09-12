import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Isolate Electron itself, not just the aggregator class. This catches helper
// entry/path/module-format errors that Node unit tests cannot reproduce. The
// smoke app has its own temporary userData and never imports Agent Code's main
// entry, opens provider sessions, or touches a real installation's state.
const worker = resolve('out/main/performanceWorker.js')
await access(worker)
const directory = await mkdtemp(join(tmpdir(), 'agent-code-monitor-smoke-'))
const require = createRequire(import.meta.url)
try {
  const entry = join(directory, 'main.cjs')
  await writeFile(entry, `
    const { app, utilityProcess } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
    app.disableHardwareAcceleration();
    app.whenReady().then(() => {
      const child = utilityProcess.fork(${JSON.stringify(worker)}, [], {
        serviceName: 'Agent Code Performance Smoke', stdio: 'ignore'
      });
      const deadline = setTimeout(() => { child.kill(); app.exit(2); }, 15000);
      child.on('message', response => {
        if (response.sequence !== 1 || response.snapshot?.operations?.[0]?.histogram?.count !== 1) {
          child.kill(); app.exit(3); return;
        }
        console.log(JSON.stringify({ ok: true, workerRss: response.snapshot.workerRss, schemaVersion: response.snapshot.schemaVersion }));
        clearTimeout(deadline); child.kill(); app.exit(0);
      });
      child.on('spawn', () => child.postMessage({ sequence: 1, records: [{
        kind: 'operation', at: Date.now(), windowId: null,
        sample: { kind: 'operation', name: 'ipc.handler', durationMs: 5, outcome: 'success' }
      }] }));
    }).catch(() => app.exit(4));
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [entry], { env, timeout: 25000, maxBuffer: 64 * 1024 })
  process.stdout.write(result.stdout)
} finally { await rm(directory, { recursive: true, force: true }) }
