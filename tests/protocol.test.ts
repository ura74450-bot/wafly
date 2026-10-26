import { describe, expect, it } from 'vitest'
import { RemoteTrack } from '../src/game/balls'
import { cameraSide, stickToWorld } from '../src/game/camera'
import { CONFIG } from '../src/game/config'
import { HIT_WINDOW, OwnBall } from '../src/game/localBall'
import { bootstrapUrl, validEndpoint } from '../src/net/connection'
import { BUILD, decode, generateRoom, sanitizeRoom, validRoom, type Pose } from '../src/net/protocol'

const RULES = { arena_radius: 10, ball_radius: 0.8, accel: 16, damping: 1.1, max_speed: 9, restitution: 0.95, win_score: 3 }
const SPAWN = { p1: { x: 0, z: 4 }, p2: { x: 0, z: -4 }, p3: { x: 4, z: 0 }, p4: { x: -4, z: 0 } }
const seat = (patch: Record<string, unknown> = {}) => ({ connected: true, playing: true, out: false, score: 0, ...patch })
const room = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'room', marker: BUILD, room: 'ROOM1', seq: 1, round: 1, phase: 'live', phase_ends_in_ms: 0,
  seats: { p1: seat(), p2: seat(), p3: seat({ connected: false, playing: false }), p4: seat({ connected: false, playing: false }) },
  winner: '', event: { seq: 0, kind: '', seat: '' }, ...patch,
})
const welcome = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'welcome', marker: BUILD, room: 'ROOM1', role: 'p1', resume_token: 'x'.repeat(32), rules: RULES, spawn: SPAWN, ...patch,
})
const pose = (patch: Partial<Pose> = {}): Pose => ({
  type: 'pose', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, seq: 1, x: 0, z: -4, vx: 0, vz: 0, lat: 0, ...patch,
})

describe('protocol', () => {
  it('accepts valid welcome, room, pose and pong messages for this build and room only', () => {
    expect(decode(welcome(), 'ROOM1', -1)?.type).toBe('welcome')
    expect(decode(welcome({ role: 'p4' }), 'ROOM1', -1)?.type).toBe('welcome')
    expect(decode(room(), 'ROOM1', -1)?.type).toBe('room')
    expect(decode(JSON.stringify(pose({ seat: 'p3' })), 'ROOM1', -1)?.type).toBe('pose')
    expect(decode(JSON.stringify({ type: 'pong', marker: BUILD, room: 'ROOM1', t: 5 }), 'ROOM1', -1)?.type).toBe('pong')
    expect(decode(JSON.stringify({ type: 'hit', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, jx: 3, jz: 0 }), 'ROOM1', -1)?.type).toBe('hit')
    expect(decode(JSON.stringify({ type: 'hit', marker: BUILD, room: 'ROOM1', seat: 'p2', round: 1, jx: 1e6, jz: 0 }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ marker: 'ring-out-v1' }), 'ROOM1', -1)).toBeNull()
    expect(decode(room(), 'OTHER', -1)).toBeNull()
  })

  it('rejects stale, malformed or unbounded messages', () => {
    expect(decode(room({ seq: 1 }), 'ROOM1', 1)).toBeNull()
    expect(decode(room({ phase: 'paused' }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ winner: 'p5' }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ event: { seq: 1, kind: 'bump', seat: '' } }), 'ROOM1', -1)).toBeNull()
    expect(decode(room({ seats: { p1: seat(), p2: seat(), p3: seat() } }), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ x: Infinity })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ x: 1e6 })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ lat: 5000 })), 'ROOM1', -1)).toBeNull()
    expect(decode(JSON.stringify(pose({ seat: 'spectator' as never })), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ role: 'admin' }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ resume_token: 'short' }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ rules: { ...RULES, ball_radius: 20 } }), 'ROOM1', -1)).toBeNull()
    expect(decode(welcome({ spawn: { ...SPAWN, p4: { x: 50, z: 0 } } }), 'ROOM1', -1)).toBeNull()
    expect(decode('{nope', 'ROOM1', -1)).toBeNull()
    expect(decode('x'.repeat(5000), 'ROOM1', -1)).toBeNull()
  })

  it('normalizes room codes and only connects to safe endpoints', () => {
    expect(sanitizeRoom(' ab-c1 ')).toBe('ABC1')
    expect(validRoom('ABC')).toBe(false)
    expect(validRoom(generateRoom(() => 0.5))).toBe(true)
    expect(validEndpoint('wss://game.example.com/ws')).toBe(true)
    expect(validEndpoint('ws://127.0.0.1:8787/ws')).toBe(true)
    expect(validEndpoint('ws://game.example.com/ws')).toBe(false)
    expect(validEndpoint('wss://user@game.example.com/ws')).toBe(false)
    expect(bootstrapUrl('https://x.dev/app/index.html?room=AB12#top')).toBe('https://x.dev/app/multiplayer/bootstrap.json')
    expect(bootstrapUrl('https://x.dev/game/__manus__/game-preview/abc/')).toBe('https://x.dev/game/multiplayer/bootstrap.json')
  })
})

describe('client-owned movement', () => {
  const expectDirection = (actual: { x: number; z: number }, x: number, z: number) => {
    expect(actual.x).toBeCloseTo(x)
    expect(actual.z).toBeCloseTo(z)
  }

  it('maps screen-up toward the arena centre for each seat', () => {
    for (const [role, up, right] of [
      ['p1', [0, -1], [1, 0]], ['p2', [0, 1], [-1, 0]], ['p3', [-1, 0], [0, -1]], ['p4', [1, 0], [0, 1]],
    ] as const) {
      const side = cameraSide(role, SPAWN)
      expectDirection(stickToWorld(side, 0, 1), up[0], up[1])
      expectDirection(stickToWorld(side, 1, 0), right[0], right[1])
    }
  })

  it('moves the own ball at once and reports the edge crossing itself', () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(0, 4)
    own.setInput(1, 0)
    own.step(1 / 60, [])
    expect(own.x).toBeGreaterThan(0)
    own.place(9.9, 0)
    own.setInput(1, 0)
    for (let i = 0; i < 30 && !own.out; i += 1) own.step(1 / 60, [])
    expect(own.out).toBe(true)
    // An out ball holds the pose where it crossed while the server confirms the ring-out.
    const crossed = { x: own.x, z: own.z }
    own.setInput(-1, 0)
    own.step(1 / 60, [])
    expect({ x: own.x, z: own.z }).toEqual(crossed)
  })
  it('keeps a ball that a touch pushed past the edge outside, even when it moves inward', () => {
    const own = new OwnBall()
    own.configure(RULES)
    own.place(9.5, 0)
    own.vx = -5
    // The other ball moves away faster, so the touch only separates the balls and has no impulse.
    expect(own.step(1 / 60, [{ seat: 'p2', ball: { x: 8.6, z: 0, vx: -6, vz: 0 } }])).toEqual([])
    expect(own.out).toBe(true)
    for (let i = 0; i < 10; i += 1) own.step(1 / 60, [])
    expect(Math.hypot(own.x, own.z)).toBeGreaterThan(RULES.arena_radius)
  })

  const pair = (aVx: number, bVx: number) => {
    const a = new OwnBall(), b = new OwnBall()
    a.configure(RULES)
    b.configure(RULES)
    a.place(-0.7, 0)
    b.place(0.7, 0)
    a.vx = aVx
    b.vx = bVx
    return { a, b, aView: { x: 0.7, z: 0, vx: bVx, vz: 0 }, bView: { x: -0.7, z: 0, vx: aVx, vz: 0 } }
  }

  it('sends the other half of a contact that only one owner detected', () => {
    // p1 runs into a resting p2. p2 cannot see the overlap, so only p1's hit moves it.
    const { a, b, aView } = pair(6, 0)
    const [contact] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    expect(contact.seat).toBe('p2')
    expect(contact.closing).toBeCloseTo(6)
    expect(a.vx).toBeCloseTo(6 - 5.85)
    expect(b.receiveHit('p1', contact.jx, contact.jz)).toBe(true)
    expect(b.vx).toBeCloseTo(5.85)
    // The pair has its impulse: p2's later view of the overlap only separates the balls.
    expect(b.step(1e-6, [{ seat: 'p1', ball: { x: 0, z: 0, vx: 6, vz: 0 } }])).toEqual([])
    expect(b.vx).toBeCloseTo(5.85)
    expect(b.x).toBeCloseTo(1.6)
  })

  it('applies a contact once when both owners detect it', () => {
    const { a, b, aView, bView } = pair(6, -6)
    const [fromA] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    const [fromB] = b.step(1e-6, [{ seat: 'p1', ball: bView }])
    // Each applied its own half and ignores the half the other sends.
    expect(b.receiveHit('p1', fromA.jx, fromA.jz)).toBe(false)
    expect(a.receiveHit('p2', fromB.jx, fromB.jz)).toBe(false)
    expect(a.vx).toBeCloseTo(-5.7)
    expect(b.vx).toBeCloseTo(5.7)
    // After the window a new contact counts again.
    for (let i = 0; i * 0.05 <= HIT_WINDOW; i += 1) a.step(0.05, [])
    expect(a.receiveHit('p2', 1, 0)).toBe(true)
  })
  it('widens the contact window to the client-to-client round trip', () => {
    const { a, b, aView, bView } = pair(6, -6)
    // 120 ms each way between the two clients: the window becomes 0.48 s.
    b.setPeerDelay('p1', 0.24)
    const [fromA] = a.step(1e-6, [{ seat: 'p2', ball: aView }])
    b.step(1e-6, [{ seat: 'p1', ball: bView }])
    // p1's half arrives 0.3 s later, past the shortest window: p2 already applied it.
    for (let i = 0; i < 6; i += 1) b.step(0.05, [])
    expect(b.receiveHit('p1', fromA.jx, fromA.jz)).toBe(false)
    for (let i = 0; i < 4; i += 1) b.step(0.05, [])
    expect(b.receiveHit('p1', 1, 0)).toBe(true)
  })

  it('keeps a steadily moving remote ball on its true position between poses', () => {
    const track = new RemoteTrack()
    track.place(0, -4)
    // 30 Hz poses, 60 Hz frames, 40 ms sender latency and 30 ms own latency, at a constant 6 m/s.
    let worst = 0
    for (let frame = 0; frame < 120; frame += 1) {
      const now = 10 + frame / 60
      if (frame % 2 === 0) {
        const sentAt = now - 0.04 - 0.03
        track.push(pose({ seq: frame + 1, x: 0, z: -4 + 6 * (sentAt - 10), vz: 6, lat: 40 }), 0.03, now)
      }
      track.update(now, 1 / 60)
      if (frame > 10) worst = Math.max(worst, Math.abs(track.z - (-4 + 6 * (now - 10))))
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('draws another ball in present time and ignores out-of-order poses', () => {
    const track = new RemoteTrack()
    track.place(0, -4)
    // The pose is 50 ms old when sent and this client is 50 ms from the server: project 0.1 s ahead.
    track.push(pose({ seq: 2, x: 0, z: -4, vz: 5, lat: 50 }), 0.05, 10)
    for (let i = 0; i < 60; i += 1) track.update(10, 1 / 60)
    expect(track.z).toBeCloseTo(-3.5, 1)
    track.push(pose({ seq: 1, z: 3 }), 0.05, 10)
    track.update(10, 1)
    expect(track.z).toBeCloseTo(-3.5, 1)
    // The projection is capped at `net.maxLead` when poses stop.
    for (let i = 0; i < 60; i += 1) track.update(12, 1 / 60)
    expect(track.z).toBeCloseTo(-4 + 5 * CONFIG.net.maxLead, 1)
    expect(track.reportedOutside(RULES.arena_radius)).toBe(false)
    track.push(pose({ seq: 3, x: 10.5, z: 0 }), 0.05, 12)
    expect(track.reportedOutside(RULES.arena_radius)).toBe(true)
  })
})
