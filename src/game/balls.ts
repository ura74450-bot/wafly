import * as THREE from 'three'
import type { Pose } from '../net/protocol'
import { CONFIG } from './config'
import type { Motion } from './localBall'

export const SEAT_COLORS = { p1: '#ff7a59', p2: '#4fb6ff', p3: '#7ddc6a', p4: '#ffd04a' } as const

/**
 * A ball another client owns, drawn in present time so the own ball hits it where it appears.
 * The estimate projects the last relayed pose forward by its age: the sender's latency, this
 * client's latency and the time since receipt, capped at `net.maxLead`. Each estimate starts from
 * the last pose, so a late pose never compounds.
 *
 * A new pose moves the estimate at once. The drawn ball keeps its place and carries the jump as
 * an offset that decays over `net.smoothTime`. The jump is measured at one instant, the old and the
 * new estimate both at `now`, so normal movement since the last frame is never counted as error. A
 * moving ball is therefore drawn on its estimate, not behind it. Only `place` (each round's spawn)
 * moves the ball without a fade.
 */
export class RemoteTrack implements Motion {
  x = 0
  z = 0
  vx = 0
  vz = 0
  private last: (Motion & { at: number; lead: number; seq: number }) | null = null
  private offsetX = 0
  private offsetZ = 0

  /** Holds the ball still at `x`, `z` and forgets older poses (spawn before each round). */
  place(x: number, z: number): void {
    Object.assign(this, { x, z, vx: 0, vz: 0, offsetX: 0, offsetZ: 0 })
    this.last = null
  }

  /** Accepts a pose in order. `latency` is this client's one-way latency in seconds; `now` is in seconds. */
  push(pose: Pose, latency: number, now: number): void {
    const previous = this.last
    if (previous && pose.seq <= previous.seq) return
    // Where the ball is drawn at `now`, before this pose: the old estimate plus its unfaded offset.
    const shown = previous ? this.estimate(previous, now) : { x: this.x, z: this.z }
    const shownX = shown.x + (previous ? this.offsetX : 0)
    const shownZ = shown.z + (previous ? this.offsetZ : 0)
    this.last = { x: pose.x, z: pose.z, vx: pose.vx, vz: pose.vz, at: now, lead: pose.lat / 1000 + latency, seq: pose.seq }
    const target = this.estimate(this.last, now)
    this.offsetX = shownX - target.x
    this.offsetZ = shownZ - target.z
    // A large error (a contact this client missed, a stalled tab) would slide across the arena: jump instead.
    if (Math.hypot(this.offsetX, this.offsetZ) > CONFIG.net.snapDistance) this.offsetX = this.offsetZ = 0
  }

  /** True when the owner's last report is past the edge: the same test the server referee uses. */
  reportedOutside(radius: number): boolean {
    return !!this.last && Math.hypot(this.last.x, this.last.z) > radius
  }

  update(now: number, seconds: number): void {
    const last = this.last
    if (!last) return
    const keep = Math.exp(-Math.max(seconds, 0) / Math.max(CONFIG.net.smoothTime, 1e-3))
    this.offsetX *= keep
    this.offsetZ *= keep
    const target = this.estimate(last, now)
    this.x = target.x + this.offsetX
    this.z = target.z + this.offsetZ
    this.vx = last.vx
    this.vz = last.vz
  }

  private estimate(last: Motion & { at: number; lead: number }, now: number): { x: number; z: number } {
    const lead = Math.min(last.lead + now - last.at, CONFIG.net.maxLead)
    return { x: last.x + last.vx * lead, z: last.z + last.vz * lead }
  }
}

function ballTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const g = canvas.getContext('2d')!
  g.fillStyle = color
  g.fillRect(0, 0, 256, 128)
  // A band and two dots make rolling readable from any camera.
  g.fillStyle = 'rgba(255, 255, 255, 0.9)'
  g.fillRect(0, 56, 256, 16)
  for (const x of [64, 192]) {
    g.beginPath()
    g.arc(x, 28, 12, 0, Math.PI * 2)
    g.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** One ball: rolling rotation from velocity, a contact shadow, an own-ball marker and a fall. */
export class BallView {
  readonly root = new THREE.Group()
  private readonly mesh: THREE.Mesh
  private readonly shadow: THREE.Mesh
  private readonly marker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private radius = 0.8
  private y = 0
  private fallSpeed = 0
  private falling = false
  private readonly drift = { x: 0, z: 0, vx: 0, vz: 0 }
  private readonly axis = new THREE.Vector3()
  private readonly spin = new THREE.Quaternion()

  constructor(color: string) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24),
      new THREE.MeshStandardMaterial({ map: ballTexture(color), roughness: 0.35, metalness: 0.1 }))
    this.mesh.castShadow = true
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false }))
    this.shadow.rotation.x = -Math.PI / 2
    this.marker = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.45, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }))
    this.marker.rotation.x = -Math.PI / 2
    this.marker.visible = false
    this.root.add(this.mesh, this.shadow, this.marker)
    this.setRadius(0.8)
  }

  setRadius(radius: number): void {
    this.radius = radius
    this.mesh.scale.setScalar(radius)
    this.shadow.scale.setScalar(radius * 0.95)
    this.marker.scale.setScalar(radius)
  }

  setOwn(own: boolean): void {
    this.marker.visible = own
  }

  /** Places the ball; `out` starts the cosmetic fall from the last drawn position and velocity. */
  update(x: number, z: number, vx: number, vz: number, out: boolean, seconds: number, time: number): void {
    if (out && !this.falling) {
      this.falling = true
      this.fallSpeed = 0
      Object.assign(this.drift, { x: this.root.position.x, z: this.root.position.z, vx, vz })
    } else if (!out && this.falling) {
      this.falling = false
      this.y = 0
    }
    if (this.falling) {
      // Keep the ball flying outward while it drops.
      this.fallSpeed += CONFIG.look.fallGravity * seconds
      this.y -= this.fallSpeed * seconds
      this.drift.x += this.drift.vx * seconds
      this.drift.z += this.drift.vz * seconds
      ;({ x, z, vx, vz } = this.drift)
    }
    this.root.position.set(x, 0, z)
    this.mesh.position.y = this.radius + this.y
    this.shadow.position.y = 0.01
    this.shadow.visible = !this.falling
    this.marker.position.y = 0.02
    this.marker.material.opacity = 0.55 + Math.sin(time * 5) * 0.3
    const speed = Math.hypot(vx, vz)
    if (speed > 1e-3) {
      // Rolling without slipping: axis is up × velocity, angle is distance / radius.
      this.axis.set(vz, 0, -vx).normalize()
      this.spin.setFromAxisAngle(this.axis, (speed * seconds) / this.radius)
      this.mesh.quaternion.premultiply(this.spin)
    }
  }
}
