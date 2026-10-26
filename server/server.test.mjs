import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

test('two players share a farm state', async () => {
  const port = 8899 + Math.floor(Math.random() * 100)
  const child = spawn(process.execPath, ['authoritative_server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 4000)
    child.stdout.on('data', data => { if (String(data).includes('sproutbound-farm-v1')) { clearTimeout(timeout); resolve() } })
    child.on('error', reject)
  })
  const room = `T${Date.now().toString().slice(-7)}`
  const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`)
    const timeout = setTimeout(() => reject(new Error('welcome timeout')), 3000)
    ws.on('message', data => { const message = JSON.parse(String(data)); if (message.type === 'welcome') { clearTimeout(timeout); resolve({ ws, message }) } })
    ws.on('error', reject)
  })
  let first
  let second
  try {
    first = await connect()
    second = await connect()
    assert.equal(first.message.state.players.length, 1)
    assert.equal(second.message.state.players.length, 2)
    first.ws.send(JSON.stringify({ type: 'input', x: -8, z: -5.6 }))
    first.ws.send(JSON.stringify({ type: 'action', action: 'plant', crop: 'pumpkin' }))
    const planted = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('state update timeout')), 3000)
      first.ws.on('message', data => { const message = JSON.parse(String(data)); if (message.type === 'state' && message.state.crops.some(crop => crop.kind === 'pumpkin')) { clearTimeout(timeout); resolve(message.state) } })
    })
    assert.equal(planted.players.length, 2)
    assert.ok(planted.crops.some(crop => crop.kind === 'pumpkin'))
  } finally {
    first?.ws.close()
    second?.ws.close()
    child.kill()
  }
})
