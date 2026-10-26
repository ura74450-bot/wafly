import * as THREE from 'three'

/** Concentric rings and spawn marks drawn once into a canvas texture. */
function floorTexture(): THREE.CanvasTexture {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const c = size / 2
  const fill = g.createRadialGradient(c, c, 0, c, c, c)
  fill.addColorStop(0, '#3b3570')
  fill.addColorStop(0.8, '#2a2556')
  fill.addColorStop(1, '#1d1942')
  g.fillStyle = fill
  g.fillRect(0, 0, size, size)
  g.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  g.lineWidth = 6
  for (let r = 0.2; r < 1; r += 0.2) {
    g.beginPath()
    g.arc(c, c, c * r, 0, Math.PI * 2)
    g.stroke()
  }
  // Danger band near the edge.
  g.strokeStyle = 'rgba(255, 92, 120, 0.35)'
  g.lineWidth = 22
  g.beginPath()
  g.arc(c, c, c * 0.93, 0, Math.PI * 2)
  g.stroke()
  g.fillStyle = 'rgba(255, 211, 92, 0.55)'
  g.beginPath()
  g.arc(c, c, 14, 0, Math.PI * 2)
  g.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/**
 * The play space: a floating disc over a starry void. The disc radius always comes from the
 * server's `welcome.rules.arena_radius`; call `setRadius()` when rules arrive.
 */
export class Arena {
  readonly scene = new THREE.Scene()
  readonly sun: THREE.DirectionalLight
  private readonly disc: THREE.Group
  private radius = 0

  constructor(shadowMapSize: number) {
    this.scene.background = new THREE.Color('#0d0b24')
    this.scene.fog = new THREE.Fog('#0d0b24', 40, 110)
    this.scene.add(new THREE.HemisphereLight('#b9c8ff', '#2a1d3f', 1.1))
    this.sun = new THREE.DirectionalLight('#fff1d6', 2.2)
    this.sun.position.set(8, 20, 6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -14
    cam.right = cam.top = 14
    cam.near = 1
    cam.far = 60
    this.scene.add(this.sun, this.sun.target)
    this.disc = new THREE.Group()
    this.scene.add(this.disc)
    this.scene.add(this.stars())
    this.setRadius(10)
  }

  setRadius(radius: number): void {
    if (radius === this.radius) return
    this.radius = radius
    for (const child of [...this.disc.children]) {
      const mesh = child as THREE.Mesh
      mesh.geometry.dispose()
      for (const material of ([] as THREE.Material[]).concat(mesh.material)) {
        (material as THREE.MeshStandardMaterial).map?.dispose()
        material.dispose()
      }
      this.disc.remove(mesh)
    }
    const top = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.6, 96),
      [new THREE.MeshStandardMaterial({ color: '#4a3f7a', roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.65, metalness: 0.05 }),
        new THREE.MeshStandardMaterial({ color: '#2a2450' })])
    top.position.y = -0.3
    top.receiveShadow = true
    const rock = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.96, radius * 0.18, radius * 0.6, 48, 1),
      new THREE.MeshStandardMaterial({ color: '#2b2148', roughness: 1, flatShading: true }))
    rock.position.y = -0.6 - radius * 0.3
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.09, 8, 128),
      new THREE.MeshStandardMaterial({ color: '#ff5c78', emissive: '#ff5c78', emissiveIntensity: 1.6 }))
    rim.rotation.x = Math.PI / 2
    rim.position.y = 0.02
    this.disc.add(top, rock, rim)
  }

  private stars(): THREE.Points {
    const count = 900
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      const dir = new THREE.Vector3().randomDirection()
      dir.y = dir.y * 0.8 - 0.2
      dir.normalize().multiplyScalar(80 + Math.random() * 40)
      positions.set([dir.x, dir.y, dir.z], i * 3)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#cfd8ff', size: 0.35, fog: false }))
  }
}
