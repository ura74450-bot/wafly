import type { Rules, Seat } from '../net/protocol'

/** A ball on the arena floor: position in metres, velocity in metres per second. */
export type Motion = { x: number; z: number; vx: number; vz: number }
/** A contact this client resolved: `seat` must receive the impulse `jx`, `jz` on its own ball. */
export type Contact = { seat: Seat; jx: number; jz: number; closing: number }

/** Longest step the own ball takes at once, so a resumed tab does not jump. */
const MAX_STEP = 0.05
/**
 * One contact per pair of balls in this window, in seconds. When both owners detect the same
 * contact, each applies only its own half and ignores the hit the other sends, so the window must
 * exceed the client-to-client round trip. This is the shortest window; `setPeerDelay()` widens it
 * for each pair to twice the measured one-way delay between the two clients.
 */
export const HIT_WINDOW = 0.25

/**
 * The player's own ball. This client owns its movement: it applies input, resolves contacts with
 * the balls it draws, and publishes the result as a `pose`. The server relays the pose and decides
 * ring-outs from it. Every client runs the same `integrate()` and `touch()` with the numbers in
 * `welcome.rules`, so all balls follow one set of rules.
 *
 * A contact is applied once per pair. The client that detects it first applies its own half of
 * the impulse and returns the other half as a `Contact`; the game sends it to the owner of the
 * other ball as a `hit`. That owner applies it with `receiveHit()`.
 */
export class OwnBall implements Motion {
  x = 0
  z = 0
  vx = 0
  vz = 0
  /**
   * Set when the ball crosses the edge. The ball then holds the pose where it crossed, so every pose
   * it publishes stays outside until the server confirms; `BallView` draws the fall.
   */
  out = false
  private rules: Rules = { arena_radius: 10, ball_radius: 0.8, accel: 16, damping: 1.1, max_speed: 9, restitution: 0.95, win_score: 3 }
  private inputX = 0
  private inputZ = 0
  /** Seconds of simulated time; the clock for `HIT_WINDOW`. */
  private clock = 0
  /** When this client last resolved a contact with each seat, and when it last sent one. */
  private readonly resolved = new Map<Seat, number>()
  private readonly sent = new Map<Seat, number>()
  /** Contact window per seat, at least `HIT_WINDOW`. */
  private readonly windows = new Map<Seat, number>()

  configure(rules: Rules): void {
    this.rules = rules
  }

  /** Holds the ball still at `x`, `z` (spawn before each round). */
  place(x: number, z: number): void {
    Object.assign(this, { x, z, vx: 0, vz: 0, out: false })
    this.resolved.clear()
    this.sent.clear()
  }

  setInput(x: number, z: number): void {
    this.inputX = x
    this.inputZ = z
  }

  /** `seconds`: one-way delay from this client to the owner of `seat` (both clients' latency). */
  setPeerDelay(seat: Seat, seconds: number): void {
    this.windows.set(seat, Math.max(HIT_WINDOW, 2 * seconds))
  }

  /** One step of own movement against the balls of other seats. Returns the contacts to send. */
  step(seconds: number, others: readonly { seat: Seat; ball: Motion }[]): Contact[] {
    const dt = Math.min(Math.max(seconds, 0), MAX_STEP)
    this.clock += dt
    if (this.out) return []
    integrate(this, this.inputX, this.inputZ, dt, this.rules)
    const contacts: Contact[] = []
    for (const { seat, ball } of others) {
      const contact = touch(this, ball, this.rules)
      // Inside the window this pair already has its impulse: only keep the balls apart.
      if (!contact || this.recent(this.resolved, seat)) continue
      const impulse = ((1 + this.rules.restitution) * contact.closing) / 2
      this.vx += impulse * contact.nx
      this.vz += impulse * contact.nz
      this.resolved.set(seat, this.clock)
      this.sent.set(seat, this.clock)
      contacts.push({ seat, jx: -impulse * contact.nx, jz: -impulse * contact.nz, closing: contact.closing })
    }
    // Same test as the server referee, on the same unrounded numbers the pose carries.
    if (Math.hypot(this.x, this.z) > this.rules.arena_radius) this.out = true
    return contacts
  }

  /** Applies the half of a contact that `seat` resolved. Returns false when it was not applied. */
  receiveHit(seat: Seat, jx: number, jz: number): boolean {
    // Both owners detected this contact, and each already applied its own half.
    if (this.out || this.recent(this.sent, seat)) return false
    this.vx += jx
    this.vz += jz
    this.resolved.set(seat, this.clock)
    return true
  }

  private recent(times: Map<Seat, number>, seat: Seat): boolean {
    const at = times.get(seat)
    return at !== undefined && this.clock - at < (this.windows.get(seat) ?? HIT_WINDOW)
  }
}

/** Input acceleration, damping, speed cap and movement for one step. */
export function integrate(ball: Motion, inputX: number, inputZ: number, dt: number, rules: Rules): void {
  ball.vx += inputX * rules.accel * dt
  ball.vz += inputZ * rules.accel * dt
  const keep = Math.exp(-rules.damping * dt)
  ball.vx *= keep
  ball.vz *= keep
  const speed = Math.hypot(ball.vx, ball.vz)
  if (speed > rules.max_speed) {
    ball.vx *= rules.max_speed / speed
    ball.vz *= rules.max_speed / speed
  }
  ball.x += ball.vx * dt
  ball.z += ball.vz * dt
}

/**
 * Moves `own` fully out of an overlap with `other`; `other` is not changed. Returns the contact
 * normal (from `other` toward `own`) and the closing speed when the balls approach each other,
 * or null when they do not touch or already move apart.
 */
export function touch(own: Motion, other: Motion, rules: Rules): { nx: number; nz: number; closing: number } | null {
  const dx = own.x - other.x
  const dz = own.z - other.z
  const distance = Math.hypot(dx, dz)
  const minimum = rules.ball_radius * 2
  if (distance >= minimum) return null
  const nx = distance > 1e-6 ? dx / distance : 0
  const nz = distance > 1e-6 ? dz / distance : 1
  own.x = other.x + nx * minimum
  own.z = other.z + nz * minimum
  const closing = (other.vx - own.vx) * nx + (other.vz - own.vz) * nz
  return closing > 0 ? { nx, nz, closing } : null
}
