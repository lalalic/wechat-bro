'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const { create } = require('../src/ws-server')

function request(ws, cmd, id) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const response = JSON.parse(raw.toString())
      if (response.id !== id) return
      ws.off('message', onMessage)
      resolve(response)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ cmd, id }))
    setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for ${id}`))
    }, 1000).unref()
  })
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

async function run() {
  const activeSends = []
  const calls = []
  let releaseFirst
  let rejectFirst
  let firstSend = true
  let markContactsStarted
  const firstSendStarted = new Promise(resolve => { releaseFirst = resolve })
  const firstSendRejected = new Promise(resolve => { rejectFirst = resolve })
  const contactsDispatchStarted = new Promise(resolve => { markContactsStarted = resolve })

  const server = create({
    port: 0,
    quiet: true,
    dispatch: async (cmd, args) => {
      calls.push(`${cmd}:${args.id}`)
      if (cmd === 'contacts') markContactsStarted()
      if (cmd === 'send-text') {
        activeSends.push(cmd)
        assert.strictEqual(activeSends.length, 1, 'sends must not overlap')
        if (firstSend) {
          firstSend = false
          releaseFirst()
          await firstSendRejected
          activeSends.pop()
          throw new Error('first send rejected')
        }
        activeSends.pop()
      }
      return cmd
    },
  })
  await server.ready
  const port = server.server.address().port
  const ws = await connect(port)

  const first = request(ws, 'send-text', 'send-1')
  await firstSendStarted
  const second = request(ws, 'send-text', 'send-2')
  const contacts = request(ws, 'contacts', 'contacts-1')
  await contactsDispatchStarted
  assert(calls.includes('contacts:contacts-1'), 'non-send command should run while send is blocked')
  rejectFirst()

  const firstResponse = await first
  assert.strictEqual(firstResponse.ok, false)
  const secondResponse = await second
  assert.deepStrictEqual(secondResponse, { ok: true, id: 'send-2', data: 'send-text' })
  assert.deepStrictEqual(await contacts, { ok: true, id: 'contacts-1', data: 'contacts' })
  assert.deepStrictEqual(calls.filter(call => call.startsWith('send-text:')), ['send-text:send-1', 'send-text:send-2'])

  ws.close()
  server.close()
  console.log('ok - WebSocket send queue serializes sends, releases after rejection, and keeps non-send dispatch concurrent')
}

run().catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
