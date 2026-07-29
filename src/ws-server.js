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
  const port = opts.port || 9231
  const quiet = !!opts.quiet
  const dispatch = opts.dispatch || (() => { throw new Error('no dispatch') })
  const onBroadcast = opts.broadcastEvent || null

  function wsLog(...args) {
    if (quiet) return
    console.error('[ws]', ...args)
  }

  /** Map of clientId → { ws, agentName } */
  const clients = new Map()

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

      // Dispatch command
      try {
        const result = await dispatch(cmd, req)
        ws.send(JSON.stringify({ ok: true, id, data: result }))
      } catch (e) {
        ws.send(JSON.stringify({ ok: false, id, error: e.message || String(e) }))
      }
    })

    ws.on('close', () => {
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
  })

  server.on('error', (err) => {
    wsLog(`Server error:`, err.message) 
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

  return { server, broadcast, sendTo, getClients, close }
}

module.exports = { create }
