const { Terminal } = require('@xterm/xterm')
const { FitAddon } = require('@xterm/addon-fit')

const statusEl = document.getElementById('status')
const metaEl = document.getElementById('meta')
const streamTextEl = document.getElementById('streamText')
const eventLogEl = document.getElementById('eventLog')
const terminalEl = document.getElementById('terminal')

if (!window.demoApi) {
  throw new Error('demoApi bridge not found')
}

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  lineHeight: 1.18,
  theme: {
    background: '#171b22',
    foreground: '#edf2f7',
    cursor: '#8bc5ff',
    selectionBackground: 'rgba(139,197,255,0.25)',
  },
})

const fitAddon = new FitAddon()
term.loadAddon(fitAddon)
term.open(terminalEl)

function fit() {
  fitAddon.fit()
  window.demoApi.resize(term.cols, term.rows)
}

term.onData((data) => {
  window.demoApi.write(data)
})

window.addEventListener('resize', fit)
setTimeout(fit, 50)

window.demoApi.onTerminalData((data) => {
  term.write(data)
})

window.demoApi.onStreamText((text) => {
  streamTextEl.textContent = text
  streamTextEl.scrollTop = streamTextEl.scrollHeight
})

window.demoApi.onStreamEvent((payload) => {
  const line = JSON.stringify(payload)
  const existing = eventLogEl.textContent ? eventLogEl.textContent.split('\n') : []
  existing.push(line)
  while (existing.length > 120) existing.shift()
  eventLogEl.textContent = existing.join('\n')
  eventLogEl.scrollTop = eventLogEl.scrollHeight
})

window.demoApi.onStatus((status) => {
  statusEl.textContent = status
})

window.demoApi.onReady((info) => {
  metaEl.textContent = [
    `cwd: ${info.cwd}`,
    `proxy: ${info.proxyUrl}`,
    `ca: ${info.caCertPath}`,
  ].join('\n')
  fit()
})

window.demoApi.onProxyLog((text) => {
  if (!text) return
  const existing = eventLogEl.textContent ? eventLogEl.textContent.split('\n') : []
  existing.push(`[proxy] ${text.trimEnd()}`)
  while (existing.length > 120) existing.shift()
  eventLogEl.textContent = existing.join('\n')
})
