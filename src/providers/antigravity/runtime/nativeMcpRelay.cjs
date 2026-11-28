// agy starts this helper as a native stdio MCP server. Only protocol bytes
// cross this socket: real HTTP credentials and stdio server secrets stay in
// the owning Agent Code process. The main process also binds the bootstrap
// to the agy process it launched, so a resumed pane cannot reuse a stale entry.
const { connect } = require('node:net')
const { readFileSync } = require('node:fs')
const [, , port] = process.argv
const bootstrap = process.env.AGENT_CODE_AGY_RELAY_BOOTSTRAP
if (!bootstrap) process.exit(1)
const grant = readFileSync(bootstrap)
if (grant.length !== 32) process.exit(1)
const frame = Buffer.alloc(36)
grant.copy(frame)
frame.writeUInt32BE(process.ppid, 32)

const socket = connect(Number(port), '127.0.0.1')
socket.on('error', () => process.exit(1))
process.stdout.on('error', () => socket.destroy())
socket.on('close', () => process.exit(0))
socket.on('connect', () => {
  socket.write(frame)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
})
