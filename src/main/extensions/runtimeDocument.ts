import type { ExtensionManifest } from '@shared/types/extensions.js'
import { childFrameCsp } from './frameDocument.js'

export const RUNTIME_DOCUMENT = '__agent-code-runtime__.html'

// The runtime owns commands and extension-wide state, while separate view
// documents own DOM mounts. No function crosses that boundary: a view sends a
// named request and receives bounded JSON. This is the key distinction from the
// legacy activate/registerView closure ABI, which remains in frameDocument.ts.
export function buildRuntimeDocument(manifest: ExtensionManifest, nonce: string): string {
  const config = JSON.stringify({ id: manifest.id, apiVersion: manifest.apiVersion, entry: manifest.entry,
    commands: manifest.contributes?.commands?.map(command => command.id) ?? [],
    views: manifest.contributes?.views?.map(view => view.id) ?? [],
  }).replace(/</g, '\\u003c')
  const script = `
const cfg = JSON.parse(document.getElementById('config').textContent);
const transport = window.agentCodeRuntimeTransport;
if (!transport) throw new Error('This document requires a managed extension runtime.');
const commands = new Map();
const requests = new Map();
const subscriptions = [];
let extension = null;
let disposed = false;
let cleanup;
const errorText = error => String(error && error.message || error).slice(0, 2000);
const api = {
  extension: { id: cfg.id, apiVersion: cfg.apiVersion },
  storage: {
    get: key => transport.request({ method: 'storage.get', key }),
    set: (key, value) => transport.request({ method: 'storage.set', key, value }),
    delete: key => transport.request({ method: 'storage.delete', key }),
    keys: () => transport.request({ method: 'storage.keys' }),
  },
  // A background engine has no focused project. Requiring the session on every
  // call keeps authority stable when windows or pane focus change underneath it;
  // main resolves that id to its own spawn cwd and rejects arbitrary roots.
  files: {
    readText: ({ sessionId, path }) => transport.request({ method: 'fs.readText', sessionId, path }),
    writeText: ({ sessionId, path, text, expectedVersion }) => transport.request({ method: 'fs.writeText', sessionId, path, text, expectedVersion }),
  },
  notifications: {
    show: (message) => transport.request({ method: 'notifications.show', message }),
  },
};
function register(map, id, handler) {
  if (typeof handler !== 'function') throw new Error('A runtime handler must be a function.');
  if (map.has(id)) throw new Error('A handler is already registered for ' + id);
  map.set(id, handler);
  return { dispose() { if (map.get(id) === handler) map.delete(id); } };
}
const context = {
  api, subscriptions,
  registerCommand(id, handler) {
    if (!cfg.commands.includes(id)) throw new Error('Command is not declared: ' + id);
    return register(commands, id, handler);
  },
  registerRequest(name, handler) {
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error('Invalid request name.');
    return register(requests, name, handler);
  },
  views: { publish(viewId, state) {
    if (!cfg.views.includes(viewId)) throw new Error('View is not declared: ' + viewId);
    return transport.request({ method: 'views.publish', viewId, state });
  } },
};
// BrowserWindow.destroy() does not promise unload events. Main sends an explicit
// shutdown and independently enforces its deadline. Stop admitting invocations
// before awaiting author cleanup; all authority was already revoked in main.
function dispose() {
  if (cleanup) return cleanup;
  disposed = true;
  cleanup = (async () => {
    try { await extension?.deactivate?.(); } catch {}
    await Promise.allSettled(subscriptions.slice().reverse().map(async subscription => {
      try { await subscription.dispose(); } catch {}
    }));
  })();
  return cleanup;
}
transport.subscribe(async message => {
  if (message.kind === 'shutdown') {
    await dispose();
    transport.send({ kind: 'stopped', id: message.id });
    return;
  }
  if (disposed) return;
  try {
    const handler = message.kind === 'command' ? commands.get(message.commandId) : requests.get(message.name);
    if (!handler) throw new Error('No runtime handler registered for ' + (message.commandId || message.name));
    const value = message.kind === 'command' ? await handler() : await handler(message.input, message.view);
    if (!disposed) transport.send({ kind: 'result', id: message.id, ok: true, ...(value === undefined ? {} : { value }) });
  } catch (error) {
    if (!disposed) transport.send({ kind: 'result', id: message.id, ok: false, error: errorText(error) });
  }
});
import('./' + cfg.entry).then(module => {
  extension = typeof module.activate === 'function' ? module : module.default;
  if (!extension || typeof extension.activate !== 'function') throw new Error('Extension entry must export activate(context).');
  if (!disposed) return extension.activate(context);
}).then(() => {
  if (!disposed) transport.send({ kind: 'ready' });
}).catch(error => { if (!disposed) transport.send({ kind: 'failed', error: errorText(error) }); });
// Teardown never carries persistence guarantees: state must be saved when it
// changes. The host revokes authority before destroying a retired runtime, so an
// async storage write from deactivate cannot sneak past an uninstall/update.
window.addEventListener('pagehide', () => { void dispose(); });

`
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${childFrameCsp(nonce, manifest.id)}"><script type="application/json" id="config">${config}</script><script type="module" nonce="${nonce}">${script}</script>`
}
