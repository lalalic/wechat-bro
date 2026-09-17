/**
 * ws-server.js — WebSocket server for multi-agent wechat-bro
 *
 * Listens on port 9231. Multiple agents can connect simultaneously.
 * Broadcasts events to all connected agents.
 * Commands are dispatched to wechat-bro and responses sent back to the requesting agent.
 *
 * Protocol:
 *   Agent → Server:  {"cmd":"auth","agent":"testneo"}  (optional identification)
 *   Agent → Server:  {"cmd":"contacts","id":"req-1"}   (any command)
 *   Server → Agent:  {"ok":true,"id":"req-1","data":[...]}  (response)
 *   Server → Agent:  {"event":"message","data":{...},"ts":...}  (broadcast event)
 *
 * Usage:
 *   const wsServer = require('./ws-server')
 *   const srv = wsServer.create({ port: 9231, dispatch, broadcastEvent })
 *   srv.broadcast({ event: 'message', data: {...}, ts: Date.now() })
 */

'use strict'

const WebSocket = require('ws')

const OUTBOUND_SEND_COMMANDS = new Set([
  'send', 'send-text', 'send-image', 'send-video', 'send-file', 'send-voice',
])

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

/**
 * Create a WebSocket server.
 *
 * @param {object} opts
 * @param {number} opts.port - Port to listen on (default 9231)
 * @param {boolean} opts.quiet - Suppress log output (default false)
 * @param {function} opts.dispatch - async (cmd, args) => result or throw
 * @param {function} opts.broadcastEvent - optional external handler for broadcasting
 * @returns {{ server: WebSocket.Server, broadcast: function, close: function, getClients: function }}
 */
function create(opts = {}) {
  const port = opts.port ?? 9231
  const quiet = !!opts.quiet
  const dispatch = opts.dispatch || (() => { throw new Error('no dispatch') })
  const onBroadcast = opts.broadcastEvent || null

  // Resolves once the server is listening; rejects (e.g. EADDRINUSE) on error.
  let _resolveReady, _rejectReady
  const ready = new Promise((resolve, reject) => {
    _resolveReady = resolve
    _rejectReady = reject
  })

  function wsLog(...args) {
    if (quiet) return
    console.error('[ws]', ...args)
  }

  /** Map of clientId → { ws, agentName } */
  const clients = new Map()
  const pendingHosts = new Map()
  const pendingOrchestratorRequests = new Map()
  let sendQueue = Promise.resolve()

  // Keep outbound sends in request-arrival order without serializing unrelated
  // commands. The tail is always released, including when a send rejects.
  function dispatchCommand(cmd, args) {
    if (!OUTBOUND_SEND_COMMANDS.has(cmd)) return dispatch(cmd, args)
    const previous = sendQueue
    let release
    sendQueue = new Promise(resolve => { release = resolve })
    return previous.then(() => dispatch(cmd, args)).finally(release)
  }

  const server = new WebSocket.Server({ port })

  server.on('connection', (ws, req) => {
    const clientId = makeId()
    const clientInfo = { ws, agentName: null, connectedAt: Date.now() }
    clients.set(clientId, clientInfo)

    const addr = req.socket.remoteAddress || 'unknown'
    wsLog(`Client ${clientId} connected from ${addr} (${clients.size} total)`) 

    // Send welcome with client ID
    ws.send(JSON.stringify({ event: 'connected', data: { clientId, serverId: 'wechat-bro' } }))

    ws.on('message', async (raw) => {
      let req
      try {
        req = JSON.parse(raw.toString())
      } catch {
        ws.send(JSON.stringify({ ok: false, error: 'invalid json', id: null }))
        return
      }

      const { cmd, id } = req

      // Special: auth command — identify this agent
      if (cmd === 'auth') {
        clientInfo.agentName = req.agent || req.name || null
        wsLog(`Client ${clientId} identified as "${clientInfo.agentName}"`) 
        ws.send(JSON.stringify({ ok: true, id, data: { clientId, agent: clientInfo.agentName } }))
        return
      }

      // Special: ping/pong for liveness
      if (cmd === 'ping') {
        ws.send(JSON.stringify({ ok: true, id, data: { pong: true, ts: Date.now() } }))
        return
      }

      // The orchestrator is a separate WebSocket client, so management
      // controls are broadcast to it and its response is matched by ID.
      const orchestratorActions = new Set(['watch', 'unwatch', 'pause', 'resident', 'status'])
      if (orchestratorActions.has(cmd)) {
        const context = cmd === 'status' ? null : (req.context || req.name || req.to || '')
        if (cmd !== 'status' && !context) {
          ws.send(JSON.stringify({ ok: false, id, error: 'Missing context (positional value or --context)' }))
          return
        }
        const requestId = `orchestrator-${makeId()}`
        const timer = setTimeout(() => {
          const pending = pendingOrchestratorRequests.get(requestId)
          if (!pending) return
          pendingOrchestratorRequests.delete(requestId)
          pending.ws.send(JSON.stringify({ ok: false, id: pending.id, error: 'orchestrator request timed out: no orchestrator is running' }))
        }, opts.orchestratorTimeoutMs || 5000)
        pendingOrchestratorRequests.set(requestId, { ws, id, timer })
        broadcast({
          event: 'orchestrator-request',
          data: { requestId, request: { cmd, ...(context ? { context } : {}), ...(req.agent ? { agent: req.agent } : {}), ...(req.mode ? { mode: req.mode } : {}), ...(req.state ? { state: req.state } : {}) } },
          ts: Date.now(),
        })
        return
      }

      if (cmd === 'orchestrator-response') {
        const pending = pendingOrchestratorRequests.get(req.requestId)
        if (!pending) return
        pendingOrchestratorRequests.delete(req.requestId)
        clearTimeout(pending.timer)
        pending.ws.send(JSON.stringify(req.ok
          ? { ok: true, id: pending.id, data: req.data || {} }
          : { ok: false, id: pending.id, error: req.error || 'orchestrator request rejected' }))
        ws.send(JSON.stringify({ ok: true, id, data: { delivered: true, requestId: req.requestId } }))
        return
      }

      // Forward orchestration control over the daemon socket; this is not a
      // WeChat send and the orchestrator owns routing and continuation.
      if (cmd === 'host') {
        if (!req.to || !req.prompt) {
          const missing = !req.to ? '--to (target contact or room)' : '--prompt (discussion context)'
          ws.send(JSON.stringify({ ok: false, id, error: `Missing ${missing}` }))
          return
        }
        const requestId = `host-${makeId()}`
        const timer = setTimeout(() => {
          const pending = pendingHosts.get(requestId)
          if (!pending) return
          pendingHosts.delete(requestId)
          pending.ws.send(JSON.stringify({ ok: false, id: pending.id, error: 'host request timed out: no orchestrator accepted the target' }))
        }, opts.hostTimeoutMs || 10000)
        pendingHosts.set(requestId, { ws, id, timer })
        broadcast({ event: 'host-discussion', data: { requestId, to: req.to, prompt: req.prompt }, ts: Date.now() })
        return
      }

      if (cmd === 'host-result') {
        const pending = pendingHosts.get(req.requestId)
        if (!pending) return
        pendingHosts.delete(req.requestId)
        clearTimeout(pending.timer)
        pending.ws.send(JSON.stringify(req.ok
          ? { ok: true, id: pending.id, data: req.data || { accepted: true } }
          : { ok: false, id: pending.id, error: req.error || 'host request rejected' }))
        return
      }

      // Dispatch command
      try {
        const result = await dispatchCommand(cmd, req)
        ws.send(JSON.stringify({ ok: true, id, data: result }))
      } catch (e) {
        ws.send(JSON.stringify({ ok: false, id, error: e.message || String(e) }))
      }
    })

    ws.on('close', () => {
      for (const [requestId, pending] of pendingHosts) {
        if (pending.ws === ws) { clearTimeout(pending.timer); pendingHosts.delete(requestId) }
      }
      for (const [requestId, pending] of pendingOrchestratorRequests) {
        if (pending.ws === ws) { clearTimeout(pending.timer); pendingOrchestratorRequests.delete(requestId) }
      }
      clients.delete(clientId)
      wsLog(`Client ${clientId}${clientInfo.agentName ? ` (${clientInfo.agentName})` : ''} disconnected (${clients.size} remaining)`) 
    })

    ws.on('error', (err) => {
      wsLog(`Error ${clientId}:`, err.message) 
      clients.delete(clientId)
    })
  })

  server.on('listening', () => {
    wsLog(`WebSocket server listening on ws://localhost:${port}`)
    _resolveReady()
  })

  server.on('error', (err) => {
    wsLog(`Server error:`, err.message)
    _rejectReady(err)
  })

  /**
   * Broadcast an event to all connected agents.
   * @param {object} msg - Must have `event` and `data` fields
   */
  function broadcast(msg) {
    const payload = JSON.stringify(msg)
    let count = 0
    for (const [cid, info] of clients) {
      try {
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(payload)
          count++
        }
      } catch (e) {
        wsLog(`Broadcast error to ${cid}:`, e.message) 
      }
    }
    if (onBroadcast) onBroadcast(msg, count)
    return count
  }

  /**
   * Send an event to a specific agent by clientId.
   */
  function sendTo(clientId, msg) {
    const info = clients.get(clientId)
    if (!info) return false
    try {
      if (info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(JSON.stringify(msg))
        return true
      }
    } catch (e) {
      wsLog(`sendTo error ${clientId}:`, e.message)
    }
    return false
  }

  /**
   * Get list of connected clients (id + agentName).
   */
  function getClients() {
    const list = []
    for (const [cid, info] of clients) {
      list.push({ clientId: cid, agentName: info.agentName, connectedAt: info.connectedAt })
    }
    return list
  }

  /**
   * Gracefully close the server.
   */
  function close() {
    for (const [cid, info] of clients) {
      try { info.ws.close() } catch {}
    }
    clients.clear()
    server.close()
  }

  return { server, broadcast, sendTo, getClients, close, ready }
}

module.exports = { create }
