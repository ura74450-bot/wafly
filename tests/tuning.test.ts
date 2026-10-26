import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG, DEFAULT_CONFIG } from '../src/game/config'
import { ArenaCamera } from '../src/game/camera'
import { tuning } from '../src/game/tuning'

const defaults = Object.fromEntries(tuning.controls.map(control => [control.id, control.default]))
afterEach(() => tuning.apply(defaults))

describe('Three.js multiplayer tuning', () => {
  it('exposes only live cosmetic controls, because the server owns the rules', () => {
    expect(tuning.controls.length).toBeGreaterThan(0)
    for (const control of tuning.controls as readonly { applyMode: string; integrity: string }[]) {
      expect(control.applyMode).toBe('LIVE')
      expect(control.integrity).toBe('COSMETIC')
    }
  })

  it('validates the entire patch before committing and preserves source defaults', () => {
    const before = tuning.read()
    for (const patch of [{ 'camera.height': 20, 'camera.fov': 999 }, { 'camera.height': 20.2 },
      { 'camera.height': '20' }, { 'camera.fov': Infinity }, { unknown: 4 }, [], null]) {
      expect(() => tuning.apply(patch)).toThrow()
      expect(tuning.read()).toEqual(before)
    }
    tuning.apply({ 'camera.height': 20, 'camera.follow': 0.5 })
    expect(CONFIG.camera.height).toBe(20)
    expect(CONFIG.camera.follow).toBe(0.5)
    expect(DEFAULT_CONFIG.camera.height).toBe(15)
    const applied = tuning.read(); tuning.apply({ 'camera.height': 20 }); expect(tuning.read()).toEqual(applied)
  })

  it('updates the actual camera without replacing it', () => {
    const camera = new ArenaCamera()
    camera.setSide({ x: 0, z: 1 })
    const before = camera.camera.projectionMatrix.clone()
    tuning.apply({ 'camera.fov': 70, 'camera.height': 20, 'camera.distance': 10 })
    camera.update(null, 1, true)
    expect(camera.camera.fov).toBe(70)
    expect(camera.camera.projectionMatrix.equals(before)).toBe(false)
    expect(camera.camera.position.y).toBeCloseTo(20)
    expect(camera.camera.position.z).toBeCloseTo(10)
  })
})
