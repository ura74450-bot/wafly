#!/usr/bin/env node
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const MARKER = 'sproutbound-farm-v1'
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8787)
const ROOT = dirname(fileURLToPath(import.meta.url))
const STATIC_ROOT = resolve(process.env.STATIC_ROOT || join(ROOT, '../dist'))
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean))
const MAX_ROOMS = 128
const MAX_CLIENTS = 256
const CROP_KEYS = ['wheat', 'corn', 'carrot', 'tomato', 'pumpkin', 'strawberry', 'potato', 'sunflower']
const CROP_DAYS = { wheat: 2, corn: 3, carrot: 2, tomato: 3, pumpkin: 4, strawberry: 3, potato: 2, sunflower: 4 }
const CROP_LABELS = { wheat: 'пшеницу', corn: 'кукурузу', carrot: 'морковь', tomato: 'томаты', pumpkin: 'тыкву', strawberry: 'клубнику', potato: 'картофель', sunflower: 'подсолнухи' }
const CROP_SELL = { wheat: 7, corn: 13, carrot: 10, tomato: 15, pumpkin: 25, strawberry: 23, potato: 12, sunflower: 20 }
const COLORS = ['#e68a5c', '#5b8def']
const NPCS = [{ name: 'Мира', x: -5.5, z: -1.5, line: 'Поля любят заботливые руки. Поливайте их каждый день!' }, { name: 'Тим', x: 7.5, z: 2.5, line: 'На рынке сегодня хорошо берут клубнику и тыквы.' }]
const MIME = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.ttf', 'font/ttf'], ['.woff2', 'font/woff2'], ['.png', 'image/png'], ['.svg', 'image/svg+xml']])

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid PORT')

function cleanRoom(value) {
  const code = String(value || '').toUpperCase()
  return /^[A-Z0-9]{4,8}$/.test(code) ? code : ''
}

function roomCode() {
  return Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 30)]).join('')
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) }
function distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z) }
function cloneRecord(keys, value) { return Object.fromEntries(keys.map(key => [key, value])) }
function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)) }

function createCrops() {
  const crops = []
  let id = 1
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 6; col += 1) {
    crops.push({ id: `plot-${id++}`, x: -8 + col * 2.1, z: -5.6 + row * 1.55, kind: null, growth: 0, watered: false, ready: false })
  }
  return crops
}

function createPlayer(id, index) {
  return { id, name: `Фермер ${index + 1}`, x: index === 0 ? -6.8 : 6.8, z: index === 0 ? 6.3 : 6.3, color: COLORS[index], seeds: cloneRecord(CROP_KEYS, 2), bag: {}, sleeping: false }
}

class FarmRoom {
  constructor(code) {
    this.code = code
    this.clients = new Set()
    this.players = new Map()
    this.day = 1
    this.minutes = 6 * 60
    this.money = 40
    this.crops = createCrops()
    this.log = ['Добро пожаловать на вашу новую ферму.']
    this.message = 'Посадите первую культуру.'
    this.lastActivity = Date.now()
  }

  add(ws) {
    if (this.clients.size >= 8) { ws.close(1013, 'room full'); return }
    this.clients.add(ws)
    const index = [...this.players.values()].length
    if (index < 2) {
      const player = createPlayer(`p${index + 1}`, index)
      this.players.set(player.id, player)
      ws.playerId = player.id
      send(ws, { type: 'welcome', marker: MARKER, id: player.id, role: 'player', state: this.snapshot() })
      this.note(`${player.name} присоединился к ферме.`)
    } else {
      ws.playerId = 'spectator'
      send(ws, { type: 'welcome', marker: MARKER, id: 'spectator', role: 'spectator', state: this.snapshot() })
    }
    this.broadcast()
  }

  remove(ws) {
    this.clients.delete(ws)
    if (ws.playerId && this.players.has(ws.playerId)) {
      const player = this.players.get(ws.playerId)
      this.note(`${player.name} покинул ферму.`)
      this.players.delete(ws.playerId)
    }
    if (!this.clients.size) this.lastActivity = Date.now()
    else this.broadcast()
  }

  note(message) {
    this.message = message
    this.log.push(message)
    if (this.log.length > 12) this.log.shift()
  }

  nearestCrop(player) {
    let closest = null
    let closestDistance = 2.25
    for (const crop of this.crops) {
      const current = distance(player, crop)
      if (current < closestDistance) { closest = crop; closestDistance = current }
    }
    return closest
  }

  nearestNpc(player) {
    return NPCS.map(npc => ({ npc, distance: distance(player, npc) })).sort((a, b) => a.distance - b.distance)[0]
  }

  action(ws, payload) {
    const player = this.players.get(ws.playerId)
    if (!player || typeof payload.action !== 'string') return
    this.lastActivity = Date.now()
    const action = payload.action
    if (action === 'plant') {
      const kind = CROP_KEYS.includes(payload.crop) ? payload.crop : 'wheat'
      const crop = this.nearestCrop(player)
      if (!crop) return this.note('Подойдите ближе к пустой грядке.')
      if (crop.kind) return this.note('Эта грядка уже занята.')
      if ((player.seeds[kind] || 0) < 1) return this.note('Таких семян больше нет — купите их в следующей версии рынка.')
      player.seeds[kind] -= 1
      crop.kind = kind
      crop.growth = 0
      crop.watered = false
      crop.ready = false
      this.note(`${player.name} посадил ${CROP_LABELS[kind]}.`)
    } else if (action === 'water') {
      const crop = this.nearestCrop(player)
      if (!crop?.kind) return this.note('Рядом нет посаженной культуры.')
      crop.watered = true
      this.note(`${player.name} полил грядку.`)
    } else if (action === 'harvest') {
      const crop = this.nearestCrop(player)
      if (!crop?.kind || !crop.ready) return this.note('Урожай ещё не созрел.')
      const kind = crop.kind
      player.bag[kind] = (player.bag[kind] || 0) + 1
      crop.kind = null
      crop.growth = 0
      crop.watered = false
      crop.ready = false
      this.note(`${player.name} собрал урожай.`)
    } else if (action === 'sell') {
      let earned = 0
      for (const [kind, amount] of Object.entries(player.bag)) earned += (CROP_SELL[kind] || 0) * Number(amount || 0)
      if (!earned) return this.note('В рюкзаке пока нечего продавать.')
      player.bag = {}
      this.money += earned
      this.note(`${player.name} продал урожай и добавил ${earned} монет в общую кассу.`)
    } else if (action === 'talk') {
      const nearest = this.nearestNpc(player)
      if (nearest.distance > 3.2) return this.note('Подойдите к жителю: Мира у дома, Тим у пруда.')
      this.note(`${nearest.npc.name}: «${nearest.npc.line}»`)
    } else if (action === 'sleep') {
      player.sleeping = true
      this.note(`${player.name} лёг спать.`)
      if (this.players.size === 1 || [...this.players.values()].every(item => item.sleeping)) this.advanceDay()
    }
    this.broadcast()
  }

  input(ws, payload) {
    const player = this.players.get(ws.playerId)
    if (!player || !finite(payload.x) || !finite(payload.z)) return
    player.x = clamp(payload.x, -14.2, 14.2)
    player.z = clamp(payload.z, -8.2, 8.2)
    this.lastActivity = Date.now()
  }

  advanceDay() {
    this.day += 1
    this.minutes = 6 * 60
    for (const player of this.players.values()) player.sleeping = false
    for (const crop of this.crops) {
      if (!crop.kind) continue
      if (crop.watered) crop.growth += 1
      crop.watered = false
      crop.ready = crop.growth >= CROP_DAYS[crop.kind]
    }
    this.note(`Начался день ${this.day}. Полейте грядки, чтобы ускорить рост.`)
  }

  tick() {
    if (!this.players.size) return
    this.minutes += 10
    if (this.minutes >= 22 * 60) this.advanceDay()
    this.broadcast()
  }

  snapshot() {
    return { room: this.code, day: this.day, minutes: this.minutes, money: this.money, goal: { target: 200, progress: this.money }, players: [...this.players.values()], crops: this.crops, message: this.message, log: this.log }
  }

  broadcast() {
    const payload = { type: 'state', marker: MARKER, state: this.snapshot() }
    for (const client of this.clients) send(client, payload)
  }
}

const rooms = new Map()
function getRoom(code) {
  let room = rooms.get(code)
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null
    room = new FarmRoom(code)
    rooms.set(code, room)
  }
  return room
}

function originAllowed(request) {
  const origin = request.headers.origin
  if (!origin || !allowedOrigins.size) return true
  return allowedOrigins.has(origin)
}

async function serve(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ok: true, service: 'sproutbound-coop', rooms: rooms.size, clients: [...rooms.values()].reduce((total, room) => total + room.clients.size, 0) }))
    return
  }
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const candidate = normalize(join(STATIC_ROOT, pathname))
  const safeRoot = `${STATIC_ROOT.endsWith('/') ? STATIC_ROOT : `${STATIC_ROOT}/`}`
  let file = candidate.startsWith(safeRoot) ? candidate : join(STATIC_ROOT, 'index.html')
  try { if (!(await stat(file)).isFile()) file = join(STATIC_ROOT, 'index.html') } catch { file = join(STATIC_ROOT, 'index.html') }
  response.writeHead(200, { 'content-type': MIME.get(extname(file)) || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' })
  createReadStream(file).pipe(response)
}

const httpServer = createServer((request, response) => { serve(request, response).catch(() => { response.writeHead(500); response.end('server error') }) })
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname !== '/ws' || !originAllowed(request)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return }
  if ([...rooms.values()].reduce((total, room) => total + room.clients.size, 0) >= MAX_CLIENTS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return }
  const room = getRoom(cleanRoom(url.searchParams.get('room')) || roomCode())
  if (!room) { socket.destroy(); return }
  wss.handleUpgrade(request, socket, head, ws => { ws.room = room; wss.emit('connection', ws, request) })
})

wss.on('connection', ws => {
  ws.room.add(ws)
  ws.on('message', raw => {
    try {
      const payload = JSON.parse(String(raw))
      if (!payload || typeof payload.type !== 'string') return
      if (payload.type === 'input') ws.room.input(ws, payload)
      else if (payload.type === 'action') ws.room.action(ws, payload)
    } catch { send(ws, { type: 'error', marker: MARKER, message: 'Некорректное сообщение.' }) }
  })
  ws.on('close', () => ws.room.remove(ws))
  ws.on('error', () => ws.close())
})

setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (!room.clients.size && now - room.lastActivity > 10 * 60_000) rooms.delete(code)
    else if (room.clients.size) room.tick()
  }
}, 1000)

httpServer.listen(PORT, HOST, () => process.stdout.write(`${JSON.stringify({ port: httpServer.address().port, host: HOST, marker: MARKER })}\n`))
