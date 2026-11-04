'use strict'

// The owner-visible WeChat UI is only a client of the existing orchestrator.
// It cannot execute shell commands, read arbitrary paths, or access WebHelm.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const WebSocket = require('ws')
const { loadAgents, parseFrontmatter, sanitizeFsName } = require('./orchestrator')

const MAX_TEXT = 64 * 1024
const MAX_REQUEST = 70 * 1024
const UI_ACTIONS = new Set(['catalog', 'control', 'agent-read', 'agent-save', 'document-read', 'document-save'])
const CONTROL_ACTIONS = new Set(['watch', 'unwatch', 'pause', 'resident'])

function revision(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}
function requireName(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(field + ' must be a non-empty exact name')
  }
  return value
}
function forbidSymlinks(target, boundary) {
  const base = path.resolve(boundary)
  const resolved = path.resolve(target)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('invalid document path')
  // Ignore absent future descendants. Existing symlink components are rejected.
  let current = base
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink data directory refused')
  for (const part of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink document path refused')
  }
}
function writeAtomic(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp')
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}
function readVersion(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > MAX_TEXT) {
    throw new Error('Document exceeds 64 KiB and cannot be edited from WeChat UI')
  }
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return { content, revision: revision(content) }
}
function extractNameList(list) {
  if (!Array.isArray(list)) return []
  return list.map(item => typeof item === 'string' ? item : item && item.name).filter(name => typeof name === 'string' && name.length > 0)
}
function daemonRequest(port, request, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, { handshakeTimeout: 3500 })
    const id = 'ui-' + crypto.randomBytes(8).toString('hex')
    let done = false
    const finish = (error, data) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      error ? reject(error) : resolve(data)
    }
    const timer = setTimeout(() => finish(new Error('WeChat service timed out')), timeout)
    ws.once('open', () => ws.send(JSON.stringify({ ...request, id })))
    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id !== id) return
      if (msg.ok) finish(null, msg.data)
      else finish(new Error(msg.error || 'WeChat command failed'))
    })
    ws.once('error', error => finish(new Error('WeChat daemon unavailable: ' + error.message)))
    ws.once('close', () => { if (!done) finish(new Error('WeChat daemon disconnected')) })
  })
}

function createUiController({
  dataDir = process.env.WECHAT_BRO_DATA_DIR || path.join(os.homedir(), '.wechat-bro'),
  port = 9231,
  send = request => daemonRequest(port, request),
  agents = loadAgents,
} = {}) {
  dataDir = path.resolve(dataDir)
  const agentDir = path.join(dataDir, 'agents')

  function agentByName(name) {
    requireName(name, 'Agent')
    const match = agents().find(agent => agent.data.name === name)
    if (!match) throw new Error('Agent not found: ' + name)
    return match
  }

  function editableAgentPath(agent) {
    const name = agent.data.name
    if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(name) || name === '.' || name === '..') {
      throw new Error('Agent name cannot be safely used as a filename')
    }
    // Preserve the actual user's filename (.md and .agent.md both load).
    // Writing a second same-name override gives ambiguous loader precedence.
    const userPath = path.resolve(agent.path)
    const isUser = userPath.startsWith(agentDir + path.sep)
    const target = isUser ? userPath : path.join(agentDir, name + '.agent.md')
    forbidSymlinks(target, dataDir)
    return target
  }

  function getDocFile(req) {
    if (!['rules', 'memory'].includes(req.kind)) throw new Error('unsupported document type')
    if (!['global', 'contact'].includes(req.scope)) throw new Error('unsupported document scope')
    if (req.scope === 'global') return path.join(dataDir, req.kind + '.md')
    const context = requireName(req.context, 'Contact')
    if (context === 'filehelper' || context === 'me') throw new Error('use global settings for system chats')
    return path.join(dataDir, 'contacts', sanitizeFsName(context), req.kind + '.md')
  }

  async function handle(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req) || !UI_ACTIONS.has(req.action)) {
      throw new Error('unsupported WeChat UI operation')
    }
    if (Buffer.byteLength(JSON.stringify(req), 'utf8') > MAX_REQUEST) throw new Error('UI request too large')

    if (req.action === 'catalog') {
      const [status, contacts, rooms] = await Promise.allSettled([
        send({ cmd: 'status' }),
        send({ cmd: 'contacts' }),
        send({ cmd: 'rooms' }),
      ])
      const agentList = agents().map(({ data }) => ({
        name: data.name, type: data.type || 'contact', harness: data.harness || 'pi',
      }))
      return {
        orchestrator: status.status === 'fulfilled' && status.value.orchestrator ? {
          contexts: (status.value.orchestrator.contexts || []).map(item => ({
            context: item.context, state: item.state, watching: !!item.watching,
            agent: item.agent || null, mode: item.mode || null,
          })),
        } : null,
        statusError: status.status === 'rejected' ? status.reason.message : null,
        daemon: status.status === 'fulfilled' && status.value.daemon ? {
          connected: !!status.value.daemon.connected, healthy: !!status.value.daemon.healthy,
          loggedIn: !!status.value.daemon.loggedIn,
        } : null,
        contacts: contacts.status === 'fulfilled' ? extractNameList(contacts.value) : [],
        rooms: rooms.status === 'fulfilled' ? extractNameList(rooms.value) : [],
        agents: agentList,
      }
    }
    if (req.action === 'control') {
      if (!CONTROL_ACTIONS.has(req.command)) throw new Error('unsupported control command')
      const context = requireName(req.context, 'Contact')
      if (context === 'me' || context === 'filehelper') throw new Error('system chats cannot be managed')
      const command = { cmd: req.command, context }
      if (req.command === 'watch') {
        if (!['maintainer', 'assistant'].includes(req.mode)) throw new Error('invalid watch mode')
        command.mode = req.mode
        if (req.agent) {
          const agent = agentByName(req.agent)
          if (agent.data.type === 'orchestrator') throw new Error('orchestrator Agent cannot watch contacts')
          command.agent = agent.data.name
        }
      }
      if (req.command === 'pause' || req.command === 'resident') {
        if (!['on', 'off'].includes(req.state)) throw new Error('invalid toggle')
        command.state = req.state
      }
      return send(command)
    }
    if (req.action === 'agent-read') {
      const agent = agentByName(req.name)
      const actual = path.resolve(agent.path)
      if (actual.startsWith(agentDir + path.sep)) forbidSymlinks(actual, dataDir)
      const { content, revision: rev } = readVersion(actual)
      return { name: agent.data.name, content, revision: rev,
        source: agent.path.startsWith(agentDir + path.sep) ? 'user override' : 'bundled default' }
    }
    if (req.action === 'agent-save') {
      const agent = agentByName(req.name)
      if (typeof req.content !== 'string' || Buffer.byteLength(req.content, 'utf8') > MAX_TEXT) throw new Error('Agent Markdown exceeds 64 KiB')
      const target = editableAgentPath(agent)
      const current = readVersion(agent.path)
      if (req.revision !== current.revision) throw new Error('Agent changed since opened; reload before saving')
      const previous = parseFrontmatter(current.content).data
      const next = parseFrontmatter(req.content)
      if (next.data.name !== previous.name || next.data.type !== previous.type) {
        throw new Error('Agent name/type cannot be changed in the WeChat UI')
      }
      // Harness, cwd, routing and permission-affecting metadata must use the
      // existing, validated orchestration controls or filehelper workflow.
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next.data)])) {
        if (key === 'description') continue
        if (JSON.stringify(previous[key]) !== JSON.stringify(next.data[key])) {
          throw new Error('Agent field ' + key + ' is read-only here; use Chats or filehelper')
        }
      }
      writeAtomic(target, req.content)
      return { name: req.name, revision: revision(req.content), source: 'user override' }
    }
    if (req.action === 'document-read' || req.action === 'document-save') {
      const file = getDocFile(req)
      forbidSymlinks(file, dataDir)
      const existing = readVersion(file)
      if (req.action === 'document-read') return existing
      if (typeof req.content !== 'string' || Buffer.byteLength(req.content, 'utf8') > MAX_TEXT) throw new Error('Document exceeds 64 KiB')
      if (req.revision !== existing.revision) throw new Error('Document changed since opened; reload before saving')
      writeAtomic(file, req.content)
      return { revision: revision(req.content) }
    }
    throw new Error('unsupported UI action')
  }
  return { handle }
}
module.exports = { createUiController, daemonRequest, revision }
