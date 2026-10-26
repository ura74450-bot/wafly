import * as THREE from 'three'
import type { Point, Role, Seat } from '../net/protocol'
import { CONFIG } from './config'

const C = CONFIG.camera

/**
 * World direction from the arena centre to the camera: behind the own spawn, so screen-up points
 * at the arena centre. Spectators look from a corner.
 */
export function cameraSide(role: Role, spawn: Record<Seat, Point>): Point {
  if (role === 'spectator') return { x: Math.SQRT1_2, z: Math.SQRT1_2 }
  const { x, z } = spawn[role]
  const length = Math.hypot(x, z)
  return length > 1e-6 ? { x: x / length, z: z / length } : { x: 0, z: 1 }
}

/** Converts stick input (x right, y up/forward) to a world direction for a camera on `side`. */
export function stickToWorld(side: Point, x: number, y: number): Point {
  // Forward is -side; right is forward rotated 90° clockwise seen from above.
  const fx = -side.x, fz = -side.z
  const rx = -fz, rz = fx
  const wx = rx * x + fx * y
  const wz = rz * x + fz * y
  const length = Math.hypot(wx, wz)
  return length > 1 ? { x: wx / length, z: wz / length } : { x: wx, z: wz }
}

/**
 * Fixed, elevated camera behind the player's own spawn (`side`). It drifts slightly toward the own ball
 * (`camera.follow`) and adds shake on bumps.
 */
export class ArenaCamera {
  readonly camera = new THREE.PerspectiveCamera(C.fov, 1, 0.1, 400)
  side: Point = { x: 0, z: 1 }
  private readonly focus = new THREE.Vector3()
  private shake = 0
  private time = 0

  setSide(side: Point): void {
    this.side = side
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount)
  }

  /** Title screen: a slow orbit around the arena. */
  orbit(seconds: number): void {
    this.time += seconds
    const t = this.time * 0.08
    this.camera.position.set(Math.sin(t) * 24, 11 + Math.sin(this.time * 0.3), Math.cos(t) * 24)
    this.camera.lookAt(0, -1, 0)
    this.applyFov()
  }

  update(own: { x: number; z: number } | null, seconds: number, reducedMotion: boolean): void {
    this.time += seconds
    const side = this.side
    const target = own ? { x: own.x * C.follow, z: own.z * C.follow } : { x: 0, z: 0 }
    const k = 1 - Math.exp(-seconds * 4)
    this.focus.x += (target.x - this.focus.x) * k
    this.focus.z += (target.z - this.focus.z) * k
    this.camera.position.set(this.focus.x + side.x * C.distance, C.height, this.focus.z + side.z * C.distance)
    this.camera.lookAt(this.focus.x - side.x * 1.5, 0, this.focus.z - side.z * 1.5)
    if (this.shake > 0 && !reducedMotion) {
      const s = this.shake * this.shake * 0.35
      this.camera.position.x += Math.sin(this.time * 61) * s
      this.camera.position.y += Math.sin(this.time * 47 + 1) * s
    }
    this.shake = Math.max(0, this.shake - seconds * 2.5)
    this.applyFov()
  }

  private applyFov(): void {
    if (this.camera.fov !== C.fov) {
      this.camera.fov = C.fov
      this.camera.updateProjectionMatrix()
    }
  }
}
