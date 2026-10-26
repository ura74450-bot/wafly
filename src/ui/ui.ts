import type { Audio } from '../engine/audio'
import type { I18n } from '../engine/i18n'
import type { Input } from '../engine/input'
import type { Locale, Quality, SaveData, SaveStore } from '../engine/save'
import { SEAT_COLORS } from '../game/balls'
import { sanitizeRoom, SEATS, type Role, type RoomState, type Seat } from '../net/protocol'

export type Screen = 'boot' | 'title' | 'hud' | 'menu' | 'settings'
/** Connection status shown before the first snapshot or when the service is not usable. */
export type NetStatus = 'connecting' | 'reconnecting' | 'unavailable' | 'update' | 'error' | 'replaced' | 'full' | 'online'

export type UiActions = {
  play(room: string): void
  /** Open or close the in-match menu. The match keeps running on the server either way. */
  menu(open: boolean): void
  leave(): void
  invite(): void
  settings(patch: Partial<SaveData>): void
}

export type HudView = { room: string; role: Role; status: NetStatus; state: RoomState | null; phaseSeconds: number }

const ICON = {
  ring: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="9" cy="12" r="3" fill="currentColor"/><circle cx="16" cy="11" r="2.2" fill="#fff" opacity=".8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="3" rx="1.5" fill="currentColor"/><rect x="4" y="10.5" width="16" height="3" rx="1.5" fill="currentColor"/><rect x="4" y="16" width="16" height="3" rx="1.5" fill="currentColor"/></svg>',
}

/** Glyphs for control hints, per input method. */
const GLYPH = {
  keyboard: { keys: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', select: '<kbd>Enter</kbd>', back: '<kbd>Esc</kbd>' },
  gamepad: { keys: '<kbd class="round">L</kbd>', select: '<kbd class="round a">A</kbd>', back: '<kbd class="round b">B</kbd>' },
}

/**
 * DOM game UI: title with room code, HUD, in-match menu and settings as HTML/CSS layered over the
 * canvas. Every screen is keyboard-, gamepad- and touch-navigable; text comes from i18n keys and
 * re-renders on language change.
 */
export class Ui {
  screen: Screen = 'boot'
  private readonly root: HTMLElement
  private readonly stack: Screen[] = []
  private hudCache = new Map<string, string>()
  private navRepeat = 0
  private lastMethod = ''
  private goUntil = 0
  private copiedUntil = 0

  constructor(
    private readonly i18n: I18n,
    private readonly save: SaveStore,
    private readonly audio: Audio,
    private readonly input: Input,
    private readonly actions: UiActions,
  ) {
    this.root = document.getElementById('ui')!
    this.root.innerHTML = this.template()
    this.root.addEventListener('click', e => this.onClick(e))
    this.root.addEventListener('input', e => this.onInput(e))
    this.root.addEventListener('focusin', e => {
      if ((e.target as HTMLElement).matches('.btn, .seg button, .toggle')) this.audio.play('ui')
    })
    window.addEventListener('keydown', e => this.onKey(e))
    i18n.onChange(() => this.translate())
    this.translate()
    this.refreshSettings()
  }

  // ─── screens ────────────────────────────────────────────────────────────

  show(screen: Screen): void {
    this.stack.length = 0
    this.setScreen(screen)
  }

  /** Open an overlay screen (settings) that returns to the current one on Back. */
  push(screen: Screen): void {
    this.stack.push(this.screen)
    this.setScreen(screen)
  }

  back(): void {
    const prev = this.stack.pop()
    if (prev) this.setScreen(prev)
    else if (this.screen === 'menu') this.actions.menu(false)
  }

  private setScreen(screen: Screen): void {
    this.screen = screen
    const overHud = screen === 'menu' || (screen === 'settings' && this.stack.includes('menu'))
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-screen]')) {
      const active = el.dataset.screen === screen || (el.dataset.screen === 'hud' && overHud)
      el.classList.toggle('is-active', active)
      el.setAttribute('aria-hidden', String(!active))
    }
    this.root.dataset.activeScreen = screen
    // Focus the first control so keyboard and gamepad players can act immediately.
    requestAnimationFrame(() => {
      const first = this.navItems()[0]
      if (first && this.input.method !== 'touch') first.focus({ preventScroll: true })
      else (document.activeElement as HTMLElement | null)?.blur?.()
    })
  }

  setBootProgress(progress: number): void {
    const bar = this.q<HTMLElement>('.boot-bar i')
    bar.style.transform = `scaleX(${Math.max(0.04, Math.min(1, progress))})`
  }

  setRoom(room: string): void {
    this.q<HTMLInputElement>('.room-input').value = room
  }

  /** A short "GO!" after each round starts. */
  go(): void {
    this.goUntil = performance.now() + 700
  }

  copied(): void {
    this.copiedUntil = performance.now() + 1500
  }

  // ─── HUD ────────────────────────────────────────────────────────────────

  updateHud(view: HudView): void {
    const { role, state } = view
    const t = (key: string, vars?: Record<string, string | number>) => this.i18n.t(key, vars)
    const name = (seat: Seat) => t(seat === role ? 'hud.you' : `hud.${seat}`)
    this.set('room', t('hud.room', { room: view.room }))
    this.set('invite', t(performance.now() < this.copiedUntil ? 'hud.copied' : 'hud.invite'))
    for (const seat of SEATS) {
      this.set(`name-${seat}`, name(seat))
      const value = state?.seats[seat]
      this.set(`score-${seat}`, String(value?.score ?? 0))
      const side = this.q(`.hud-side-${seat}`)
      // P1 and P2 always show; P3 and P4 show once they join or score.
      side.hidden = (seat === 'p3' || seat === 'p4') && !(value && (value.connected || value.score > 0))
      side.classList.toggle('is-away', !!value && !value.connected)
      side.classList.toggle('is-out', !!value && value.out && state?.phase === 'live')
    }
    this.q('.hud-status').dataset.status = view.status === 'online' ? (state?.phase ?? 'waiting') : 'offline'

    let banner = ''
    let sub = ''
    if (view.status !== 'online') banner = t(`status.${view.status}`)
    else if (!state) banner = t('status.connecting')
    else if (state.phase === 'waiting') {
      banner = t(role === 'spectator' ? 'status.watching' : 'status.waiting')
      if (role !== 'spectator') sub = t('status.waiting.sub')
    } else if (state.phase === 'countdown') banner = String(Math.max(1, Math.ceil(view.phaseSeconds)))
    else if (state.phase === 'live' && performance.now() < this.goUntil) banner = t('status.go')
    else if (state.phase === 'live' && role !== 'spectator' && state.seats[role].playing && state.seats[role].out) banner = t('status.out')
    else if (state.phase === 'point') {
      const scorer = state.event.kind === 'point' ? state.event.seat : ''
      banner = t('status.ringout')
      sub = scorer === '' ? t('status.draw') : scorer === role ? t('status.point.you') : t('status.point', { player: name(scorer) })
    }
    else if (state.phase === 'ended' && state.winner) {
      banner = role === 'spectator' ? t('status.wins', { player: name(state.winner) }) : t(state.winner === role ? 'status.won' : 'status.lost')
      sub = t('status.rematch', { s: Math.ceil(view.phaseSeconds) })
    }
    this.set('banner', banner)
    this.set('banner-sub', sub)
    this.q('.hud-banner').classList.toggle('is-active', banner !== '')
    const showHint = role !== 'spectator' && view.status === 'online' && (!state || state.phase === 'waiting' || state.phase === 'countdown')
    this.q('.hint').classList.toggle('is-active', showHint)
  }

  private renderHint(): void {
    const method = this.input.method
    const glyph = method === 'gamepad' ? GLYPH.gamepad : GLYPH.keyboard
    this.q('.hint span').innerHTML = this.i18n.t(method === 'touch' ? 'hint.move.touch' : 'hint.move', { keys: glyph.keys })
  }

  // ─── settings ───────────────────────────────────────────────────────────

  /** Re-read the save into the Settings controls (call after changing settings outside the UI). */
  refreshSettings(): void {
    const d = this.save.data
    this.q<HTMLInputElement>('[name="musicVolume"]').value = String(d.musicVolume)
    this.q<HTMLInputElement>('[name="sfxVolume"]').value = String(d.sfxVolume)
    for (const t of this.qa<HTMLButtonElement>('.toggle')) {
      const on = d[t.dataset.setting as 'muted' | 'reducedMotion'] === true
      t.setAttribute('aria-pressed', String(on))
      t.querySelector('span')!.setAttribute('data-i18n', on ? 'settings.on' : 'settings.off')
    }
    for (const b of this.qa<HTMLButtonElement>('.seg button')) {
      const key = b.parentElement!.dataset.setting as 'quality' | 'locale'
      const current = key === 'locale' ? this.i18n.locale : d.quality
      b.setAttribute('aria-pressed', String(b.dataset.value === current))
    }
    for (const r of this.qa<HTMLInputElement>('input[type="range"]')) r.style.setProperty('--fill', `${((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100}%`)
    this.translate()
  }

  // ─── events ─────────────────────────────────────────────────────────────

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action], .toggle, .seg button')
    if (!target) return
    this.audio.unlock()
    if (target.matches('.toggle')) {
      const key = target.dataset.setting as 'muted' | 'reducedMotion'
      this.actions.settings({ [key]: !this.save.data[key] })
      this.refreshSettings()
      this.audio.play('ui')
      return
    }
    if (target.matches('.seg button')) {
      const key = target.parentElement!.dataset.setting
      if (key === 'quality') this.actions.settings({ quality: target.dataset.value as Quality })
      if (key === 'locale') this.actions.settings({ locale: target.dataset.value as Locale })
      this.refreshSettings()
      this.audio.play('ui')
      return
    }
    switch (target.dataset.action) {
      case 'play': this.play(); break
      case 'menu': this.actions.menu(true); break
      case 'close-menu': this.actions.menu(false); break
      case 'leave': this.actions.leave(); break
      case 'invite': this.actions.invite(); break
      case 'settings': this.push('settings'); break
      case 'back': this.back(); break
    }
  }

  private play(): void {
    const field = this.q<HTMLInputElement>('.room-input')
    const room = sanitizeRoom(field.value)
    field.value = room
    field.classList.toggle('is-invalid', room.length > 0 && room.length < 4)
    if (room.length > 0 && room.length < 4) return
    this.actions.play(room)
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement
    if (el.matches('.room-input')) {
      el.value = sanitizeRoom(el.value)
      el.classList.remove('is-invalid')
      return
    }
    if (el.type !== 'range') return
    el.style.setProperty('--fill', `${((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100}%`)
    this.actions.settings({ [el.name]: Number(el.value) } as Partial<SaveData>)
  }

  private onKey(e: KeyboardEvent): void {
    if (this.screen === 'hud' || this.screen === 'boot') return
    const typing = (e.target as HTMLElement).matches?.('input[type="text"]')
    if (typing && e.code === 'Enter' && this.screen === 'title') {
      e.preventDefault()
      this.play()
      return
    }
    if ((e.code === 'Escape' || (e.code === 'Backspace' && !typing)) && this.screen !== 'title') {
      // The menu toggle in main.ts owns Escape on the menu screen itself.
      if (this.screen !== 'menu') {
        e.preventDefault()
        // Escape is also the menu toggle; consume it so leaving Settings doesn't close the menu.
        this.input.consume('pause')
        this.back()
      }
      return
    }
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault()
      this.moveFocus(e.code === 'ArrowDown' ? 1 : -1)
    }
  }

  /** Per-frame gamepad menu navigation (keyboard uses native focus + onKey). */
  frame(frameSeconds: number): void {
    if (this.input.method !== this.lastMethod) {
      this.lastMethod = this.input.method
      this.renderPrompts()
      this.renderHint()
    }
    if (this.screen === 'hud' || this.screen === 'boot') return
    if (this.input.method !== 'gamepad') {
      this.input.consume('confirm')
      this.input.consume('back')
      return
    }
    const y = this.input.move.y
    const x = this.input.move.x
    this.navRepeat = Math.max(0, this.navRepeat - frameSeconds)
    const active = document.activeElement as HTMLElement | null
    if (Math.abs(y) > 0.6 && this.navRepeat <= 0) {
      this.moveFocus(y < 0 ? 1 : -1)
      this.navRepeat = 0.22
    } else if (Math.abs(x) > 0.6 && this.navRepeat <= 0 && active?.matches('input[type="range"]')) {
      const r = active as HTMLInputElement
      r.value = String(Number(r.value) + Math.sign(x) * Number(r.step || 0.1))
      r.dispatchEvent(new Event('input', { bubbles: true }))
      this.navRepeat = 0.12
    } else if (Math.abs(x) > 0.6 && this.navRepeat <= 0 && active?.parentElement?.matches('.seg')) {
      const sib = (Math.sign(x) > 0 ? active.nextElementSibling : active.previousElementSibling) as HTMLElement | null
      sib?.focus()
      this.navRepeat = 0.22
    } else if (Math.abs(y) < 0.3 && Math.abs(x) < 0.3) {
      this.navRepeat = 0
    }
    if (this.input.consume('confirm')) active?.click()
    if (this.input.consume('back') && this.screen !== 'title') this.back()
  }

  private navItems(): HTMLElement[] {
    const screen = this.q(`[data-screen="${this.screen}"]`)
    return [...screen.querySelectorAll<HTMLElement>('[data-nav]')].filter(el => el.offsetParent !== null && !el.closest('.is-hidden'))
  }

  private moveFocus(dir: 1 | -1): void {
    const items = this.navItems()
    if (items.length === 0) return
    // Buttons inside one segmented control count as a single row.
    const rows: HTMLElement[][] = []
    for (const el of items) {
      const seg = el.parentElement?.matches('.seg') ? el.parentElement : null
      const last = rows[rows.length - 1]
      if (seg && last && last[0].parentElement === seg) last.push(el)
      else rows.push([el])
    }
    const current = rows.findIndex(r => r.includes(document.activeElement as HTMLElement))
    const next = rows[(current + dir + rows.length) % rows.length]
    ;(next.find(el => el.getAttribute('aria-pressed') === 'true') ?? next[0]).focus()
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private translate(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = this.i18n.t(el.dataset.i18n!)
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n-label]')) el.setAttribute('aria-label', this.i18n.t(el.dataset.i18nLabel!))
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = this.i18n.t(el.dataset.i18nPlaceholder!)
    this.renderPrompts()
    this.renderHint()
    this.hudCache.clear()
    document.title = this.i18n.t('game.title')
  }

  /** Bottom-bar button prompts follow the active input method. */
  renderPrompts(): void {
    const g = this.input.method === 'gamepad' ? GLYPH.gamepad : GLYPH.keyboard
    const html = this.input.method === 'touch' ? '' : `<span>${g.select} ${this.i18n.t('prompt.select')}</span><span>${g.back} ${this.i18n.t('prompt.back')}</span>`
    for (const el of this.qa('.prompts')) el.innerHTML = html
  }

  /** Update a HUD text slot only when it changed. Values are plain text, never HTML. */
  private set(slot: string, text: string): void {
    if (this.hudCache.get(slot) === text) return
    this.hudCache.set(slot, text)
    this.q(`[data-slot="${slot}"]`).textContent = text
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }

  private qa<T extends HTMLElement = HTMLElement>(sel: string): T[] {
    return [...this.root.querySelectorAll<T>(sel)]
  }

  private template(): string {
    const range = (name: string, label: string, min: number, max: number, step: number) =>
      `<label class="row"><span data-i18n="${label}"></span><input data-nav type="range" name="${name}" min="${min}" max="${max}" step="${step}"></label>`
    const toggle = (setting: string, label: string) =>
      `<div class="row"><span data-i18n="${label}"></span><button data-nav class="toggle" data-setting="${setting}" aria-pressed="false"><i></i><span></span></button></div>`
    const side = (seat: Seat) =>
      `<div class="hud-side hud-side-${seat}" style="--seat:${SEAT_COLORS[seat]}"><i></i><span data-slot="name-${seat}"></span><b data-slot="score-${seat}"></b></div>`
    return /* html */ `
<section class="screen screen-boot is-active" data-screen="boot">
  <div class="boot-logo" data-i18n="game.title"></div>
  <div class="boot-bar"><i></i></div>
  <div class="boot-label" data-i18n="boot.loading"></div>
</section>

<section class="screen screen-title" data-screen="title">
  <div class="title-vignette"></div>
  <div class="title-block">
    <div class="logo">
      <span class="logo-gem">${ICON.ring}</span>
      <h1 class="logo-text" data-i18n="game.title"></h1>
    </div>
    <p class="tagline" data-i18n="game.tagline"></p>
    <label class="room-row"><span data-i18n="menu.room"></span>
      <input data-nav class="room-input" type="text" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="characters" data-i18n-placeholder="menu.room.placeholder">
    </label>
    <nav class="menu">
      <button data-nav class="btn btn-primary" data-action="play"><span data-i18n="menu.play"></span></button>
      <button data-nav class="btn" data-action="settings"><span data-i18n="menu.settings"></span></button>
    </nav>
    <p class="title-note" data-i18n="menu.note"></p>
  </div>
  <footer class="bottom-bar"><div class="prompts"></div><small data-i18n="credits.fonts"></small></footer>
</section>

<section class="screen screen-hud" data-screen="hud">
  <div class="hud-top-left">
    <div class="hud-panel hud-room"><span class="hud-status" data-status="offline"></span><b data-slot="room"></b></div>
    <button class="btn btn-small hud-invite" data-action="invite"><span data-slot="invite"></span></button>
  </div>
  <div class="hud-top-center">
    <div class="hud-score">${SEATS.map(side).join('')}</div>
  </div>
  <div class="hud-top-right">
    <button class="hud-pause" data-action="menu" data-i18n-label="menu.title">${ICON.menu}</button>
  </div>
  <div class="hud-banner"><b data-slot="banner"></b><span data-slot="banner-sub"></span></div>
  <div class="hint"><span></span></div>
  <div class="touch">
    <div class="touch-stick"><i></i></div>
  </div>
</section>

<section class="screen screen-menu screen-modal" data-screen="menu">
  <div class="modal">
    <h2 class="modal-title" data-i18n="menu.title"></h2>
    <p class="modal-note" data-i18n="menu.live"></p>
    <nav class="menu">
      <button data-nav class="btn btn-primary" data-action="close-menu"><span data-i18n="menu.continue"></span></button>
      <button data-nav class="btn" data-action="settings"><span data-i18n="menu.settings"></span></button>
      <button data-nav class="btn" data-action="leave"><span data-i18n="menu.leave"></span></button>
    </nav>
  </div>
  <footer class="bottom-bar"><div class="prompts"></div></footer>
</section>

<section class="screen screen-settings screen-modal" data-screen="settings">
  <div class="modal modal-wide">
    <h2 class="modal-title" data-i18n="settings.title"></h2>
    <div class="settings-grid">
      <fieldset><legend data-i18n="settings.audio"></legend>
        ${range('musicVolume', 'settings.music', 0, 1, 0.05)}
        ${range('sfxVolume', 'settings.sfx', 0, 1, 0.05)}
        ${toggle('muted', 'settings.mute')}
      </fieldset>
      <fieldset><legend data-i18n="settings.display"></legend>
        <div class="row"><span data-i18n="settings.quality"></span><div class="seg" data-setting="quality">
          <button data-nav data-value="low" data-i18n="settings.quality.low"></button><button data-nav data-value="medium" data-i18n="settings.quality.medium"></button><button data-nav data-value="high" data-i18n="settings.quality.high"></button>
        </div></div>
        ${toggle('reducedMotion', 'settings.reducedMotion')}
        <div class="row"><span data-i18n="settings.language"></span><div class="seg" data-setting="locale">
          <button data-nav data-value="en" lang="en">English</button><button data-nav data-value="zh-CN" lang="zh-CN">简体中文</button>
        </div></div>
      </fieldset>
    </div>
    <nav class="menu menu-row"><button data-nav class="btn" data-action="back"><span data-i18n="menu.back"></span></button></nav>
  </div>
  <footer class="bottom-bar"><div class="prompts"></div></footer>
</section>`
  }
}
