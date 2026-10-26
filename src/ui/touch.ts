import type { Input } from '../engine/input'

/**
 * On-screen touch control: one floating stick that appears wherever the thumb lands on the arena.
 * Enabled automatically on the first touch.
 */
export class TouchControls {
  private stickId: number | null = null
  private origin = { x: 0, y: 0 }
  private readonly stick: HTMLElement
  private readonly knob: HTMLElement

  constructor(root: HTMLElement, private readonly input: Input, private readonly active: () => boolean) {
    const layer = root.querySelector<HTMLElement>('.touch')!
    this.stick = layer.querySelector('.touch-stick')!
    this.knob = this.stick.querySelector('i')!
    const radius = 56

    const enable = () => document.body.classList.add('has-touch')
    if (matchMedia('(pointer: coarse)').matches) enable()
    window.addEventListener('touchstart', enable, { once: true, passive: true })
    // Any touch switches hints/prompts to touch, even taps on menu buttons.
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') this.input.method = 'touch'
    }, { capture: true })

    const canvas = document.querySelector<HTMLCanvasElement>('#game')!
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !this.active() || this.stickId !== null) return
      this.stickId = e.pointerId
      this.origin = { x: e.clientX, y: e.clientY }
      this.stick.style.left = `${e.clientX}px`
      this.stick.style.top = `${e.clientY}px`
      this.stick.classList.add('is-active')
    })
    window.addEventListener('pointermove', e => {
      if (e.pointerId !== this.stickId) return
      let dx = e.clientX - this.origin.x
      let dy = e.clientY - this.origin.y
      const len = Math.hypot(dx, dy)
      if (len > radius) {
        dx = (dx / len) * radius
        dy = (dy / len) * radius
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`
      this.input.setTouchMove(dx / radius, -dy / radius)
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return
      this.stickId = null
      this.knob.style.transform = ''
      this.stick.classList.remove('is-active')
      this.input.setTouchMove(0, 0)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
}
