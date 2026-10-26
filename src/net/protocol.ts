/**
 * Wire format shared with `server/authoritative_server.mjs`. Each client simulates and publishes
 * its own ball as a `pose`; the server relays poses and contact `hit`s, owns seats, phases and
 * scores, and decides every ring-out. The client validates everything it receives before the game
 * reads it.
 */
export const BUILD = 'ring-out-v2'
export const MAX_MESSAGE_BYTES = 4096

export type Seat = 'p1' | 'p2' | 'p3' | 'p4'
export type Role = Seat | 'spectator'
export type Phase = 'waiting' | 'countdown' | 'live' | 'point' | 'ended'
/** `round`: a round went live. `ringout`: `seat` left the arena. `point`: `seat` (or nobody) took the round. `match`: `seat` won. */
export type EventKind = '' | 'round' | 'ringout' | 'point' | 'match'
export type Rules = { arena_radius: number; ball_radius: number; accel: number; damping: number; max_speed: number; restitution: number; win_score: number }
export type Point = { x: number; z: number }
export type SeatState = { connected: boolean; playing: boolean; out: boolean; score: number }

export type Welcome = { type: 'welcome'; marker: string; room: string; role: Role; resume_token: string; rules: Rules; spawn: Record<Seat, Point> }
/** Room state. The server sends it only when something changes; `event.seq` identifies each event once. */
export type RoomState = {
  type: 'room'; marker: string; room: string; seq: number; round: number; phase: Phase; phase_ends_in_ms: number
  seats: Record<Seat, SeatState>; winner: Seat | ''; event: { seq: number; kind: EventKind; seat: Seat | '' }
}
/** Another client's own ball. `lat` is that client's one-way latency estimate in milliseconds. */
export type Pose = { type: 'pose'; marker: string; room: string; seat: Seat; round: number; seq: number; x: number; z: number; vx: number; vz: number; lat: number }
/** `seat` bumped this client's ball and sends this ball's half of the contact impulse. */
export type Hit = { type: 'hit'; marker: string; room: string; seat: Seat; round: number; jx: number; jz: number }
export type Pong = { type: 'pong'; marker: string; room: string; t: number }
export type ServiceError = { type: 'error'; marker: string; room: string; code: 'invalid_message' }
export type Message = Welcome | RoomState | Pose | Hit | Pong | ServiceError

export const SEATS: readonly Seat[] = ['p1', 'p2', 'p3', 'p4']
const PHASES: readonly string[] = ['waiting', 'countdown', 'live', 'point', 'ended']
const EVENTS: readonly string[] = ['', 'round', 'ringout', 'point', 'match']
const TYPES: readonly string[] = ['welcome', 'room', 'pose', 'hit', 'pong', 'error']
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const POSITION_LIMIT = 100
const SPEED_LIMIT = 100
const MAX_LATENCY_MS = 1000

type Raw = Record<string, unknown>
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isUint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const within = (value: unknown, limit: number): value is number => isNumber(value) && Math.abs(value) <= limit
const isSeat = (value: unknown): value is Seat => SEATS.includes(value as Seat)

export function validRoom(value: string): boolean {
  return /^[A-Z0-9]{4,8}$/.test(value)
}

export function sanitizeRoom(value: string | null | undefined): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

export function generateRoom(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < 6; i += 1) code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]
  return code
}

/** Parses only the envelope so a different `marker` can be reported as an update, not as noise. */
export function parseEnvelope(text: string): Raw | null {
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return null
  try {
    const raw: unknown = JSON.parse(text)
    return isObject(raw) && TYPES.includes(raw.type as string) ? raw : null
  } catch {
    return null
  }
}

function validRules(raw: unknown): raw is Rules {
  if (!isObject(raw)) return false
  const { arena_radius: arena, ball_radius: ball, accel, damping, max_speed: max, restitution, win_score: win } = raw
  return within(arena, POSITION_LIMIT) && arena > 0 && within(ball, 10) && ball > 0 && ball < arena
    && within(accel, 200) && accel > 0 && within(damping, 20) && damping >= 0 && within(max, SPEED_LIMIT) && max > 0
    && within(restitution, 1) && restitution >= 0 && isUint(win) && win > 0 && win <= 99
}

function validSpawn(raw: unknown, arena: number): raw is Record<Seat, Point> {
  return isObject(raw) && SEATS.every(seat => {
    const point = raw[seat]
    return isObject(point) && within(point.x, arena) && within(point.z, arena)
  })
}

function validSeat(raw: unknown): raw is SeatState {
  return isObject(raw) && typeof raw.connected === 'boolean' && typeof raw.playing === 'boolean' && typeof raw.out === 'boolean' && isUint(raw.score)
}

/**
 * Returns a message only when every field the game reads is present and bounded. `lastSeq` keeps
 * out-of-order room states out; poses are ordered per seat by the game.
 */
export function decode(text: string, room: string, lastSeq: number): Message | null {
  const raw = parseEnvelope(text)
  if (!raw || raw.marker !== BUILD || raw.room !== room) return null
  if (raw.type === 'error') return raw.code === 'invalid_message' ? (raw as ServiceError) : null
  if (raw.type === 'pong') return isUint(raw.t) ? (raw as Pong) : null
  if (raw.type === 'welcome') {
    if (!(isSeat(raw.role) || raw.role === 'spectator') || typeof raw.resume_token !== 'string') return null
    if (raw.resume_token.length > 128 || (raw.role !== 'spectator' && raw.resume_token.length < 16)) return null
    return validRules(raw.rules) && validSpawn(raw.spawn, raw.rules.arena_radius) ? (raw as Welcome) : null
  }
  if (raw.type === 'pose') {
    const valid = isSeat(raw.seat) && isUint(raw.round) && isUint(raw.seq)
      && within(raw.x, POSITION_LIMIT) && within(raw.z, POSITION_LIMIT) && within(raw.vx, SPEED_LIMIT) && within(raw.vz, SPEED_LIMIT)
      && isUint(raw.lat) && raw.lat <= MAX_LATENCY_MS
    return valid ? (raw as Pose) : null
  }
  if (raw.type === 'hit') {
    return isSeat(raw.seat) && isUint(raw.round) && within(raw.jx, SPEED_LIMIT) && within(raw.jz, SPEED_LIMIT) ? (raw as Hit) : null
  }
  if (!isUint(raw.seq) || raw.seq <= lastSeq || !isUint(raw.round) || !PHASES.includes(raw.phase as string) || !isUint(raw.phase_ends_in_ms)) return null
  const { seats, event } = raw
  if (!isObject(seats) || !isObject(event) || !SEATS.every(seat => validSeat(seats[seat]))) return null
  if (!(raw.winner === '' || isSeat(raw.winner)) || !isUint(event.seq) || !EVENTS.includes(event.kind as string)) return null
  if (!(event.seat === '' || isSeat(event.seat))) return null
  return raw as RoomState
}
