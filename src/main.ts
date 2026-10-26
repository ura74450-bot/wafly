import './styles/main.css'
import * as THREE from 'three'

type CropKind = 'wheat' | 'corn' | 'carrot' | 'tomato' | 'pumpkin' | 'strawberry' | 'potato' | 'sunflower'
type Action = 'plant' | 'water' | 'harvest' | 'talk' | 'sell' | 'sleep'

type Crop = {
  id: string
  x: number
  z: number
  kind: CropKind | null
  growth: number
  watered: boolean
  ready: boolean
}

type Player = {
  id: string
  name: string
  x: number
  z: number
  color: string
  seeds: Record<CropKind, number>
  bag: Partial<Record<CropKind, number>>
  sleeping: boolean
}

type FarmState = {
  room: string
  day: number
  minutes: number
  money: number
  goal: { target: number; progress: number }
  players: Player[]
  crops: Crop[]
  message: string
  log: string[]
}

type ServerWelcome = { type: 'welcome'; id: string; state: FarmState }
type ServerState = { type: 'state'; state: FarmState }
type ServerMessage = ServerWelcome | ServerState | { type: 'error'; message: string }

type CropDefinition = { label: string; color: number; accent: number; cost: number; sell: number; days: number; icon: string }

const CROP_DEFS: Record<CropKind, CropDefinition> = {
  wheat: { label: 'Пшеница', color: 0xf4c95d, accent: 0xd9952b, cost: 2, sell: 7, days: 2, icon: '🌾' },
  corn: { label: 'Кукуруза', color: 0xf6d55c, accent: 0xf28e2b, cost: 4, sell: 13, days: 3, icon: '🌽' },
  carrot: { label: 'Морковь', color: 0xff8c42, accent: 0xd95d39, cost: 3, sell: 10, days: 2, icon: '🥕' },
  tomato: { label: 'Томаты', color: 0xf25f5c, accent: 0xc83e4d, cost: 4, sell: 15, days: 3, icon: '🍅' },
  pumpkin: { label: 'Тыква', color: 0xf8961e, accent: 0xe85d04, cost: 7, sell: 25, days: 4, icon: '🎃' },
  strawberry: { label: 'Клубника', color: 0xff7096, accent: 0xc9184a, cost: 6, sell: 23, days: 3, icon: '🍓' },
  potato: { label: 'Картофель', color: 0xb08968, accent: 0x7f5539, cost: 3, sell: 12, days: 2, icon: '🥔' },
  sunflower: { label: 'Подсолнух', color: 0xffd000, accent: 0x8d6e00, cost: 5, sell: 20, days: 4, icon: '🌻' },
}
const CROP_KEYS = Object.keys(CROP_DEFS) as CropKind[]

const canvas = document.querySelector<HTMLCanvasElement>('#game')!
const ui = document.querySelector<HTMLDivElement>('#ui')!

let socket: WebSocket | null = null
let state: FarmState | null = null
let playerId = ''
let selectedCrop: CropKind = 'wheat'
let lastStateAt = 0
let toastTimer = 0
const held = new Set<string>()
const localPosition = new THREE.Vector2()
const playerMeshes = new Map<string, THREE.Group>()
const cropMeshes = new Map<string, THREE.Group>()
let scene: THREE.Scene
let camera: THREE.OrthographicCamera
let renderer: THREE.WebGLRenderer
let clock: THREE.Clock
let farmGroup: THREE.Group

function randomRoom(): string {
  return Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 30)]).join('')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] ?? char))
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function toast(message: string): void {
  const element = document.querySelector<HTMLDivElement>('#toast')
  if (!element) return
  element.textContent = message
  element.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => element.classList.remove('show'), 2600)
}

function buildUi(): void {
  ui.innerHTML = `
    <div id="title-screen" class="screen active">
      <div class="title-copy">
        <div class="eyebrow">CO-OP FARMING MVP</div>
        <h1>Sproutbound</h1>
        <p class="subtitle">Посади идею. Вырасти историю.</p>
        <p class="intro">Уютная ферма для двоих: выращивайте культуры, помогайте соседям и соберите сезонную кассу вместе.</p>
        <div class="room-form">
          <label for="room-input">Код фермы</label>
          <div class="room-controls"><input id="room-input" maxlength="8" value="" placeholder="например, LUNA7" /><button id="play-button" class="primary">Войти на ферму</button></div>
        </div>
        <div class="quick-tips"><span>WASD / стрелки — движение</span><span>1–8 — семена</span><span>E — действие</span></div>
      </div>
      <div class="title-art" aria-hidden="true"><div class="sun"></div><div class="hill hill-back"></div><div class="hill hill-front"></div><div class="title-house"><i></i><b></b></div><div class="title-tree tree-a"></div><div class="title-tree tree-b"></div></div>
      <div class="title-footer">Sproutbound Co-op · оригинальный прототип · Render-ready</div>
    </div>
    <div id="game-screen" class="screen game-screen">
      <div class="hud top-hud"><div><span class="hud-label">ФЕРМА</span><strong id="hud-room">—</strong></div><div><span class="hud-label">ДЕНЬ</span><strong id="hud-day">1 · 06:00</strong></div><div><span class="hud-label">КАССА</span><strong id="hud-money">0 🪙</strong></div><div class="connection"><span id="connection-dot"></span><span id="connection-label">подключение</span></div></div>
      <div class="hud side-panel"><div class="panel-kicker">СЕЗОННАЯ ЦЕЛЬ</div><div id="goal-text" class="goal-text">Накопите 200 монет</div><div class="progress"><i id="goal-progress"></i></div><div class="players-title">КОМАНДА</div><div id="players-list"></div><div class="panel-divider"></div><div class="panel-kicker">КУЛЬТУРЫ</div><div id="seed-list" class="seed-list"></div></div>
      <div class="hud bottom-panel"><div id="action-hint">Выберите грядку и нажмите E</div><div class="action-row"><button data-action="plant">P посадить</button><button data-action="water">W полить</button><button data-action="harvest">H собрать</button><button data-action="talk">E говорить</button><button data-action="sell">S продать</button><button data-action="sleep">Z спать</button></div></div>
      <div class="log-card"><div class="panel-kicker">ЖУРНАЛ</div><div id="event-log"></div></div>
      <div id="mobile-controls" class="mobile-controls"><button data-move="up">▲</button><div><button data-move="left">◀</button><button data-move="down">▼</button><button data-move="right">▶</button></div></div>
    </div>
    <div id="toast" role="status"></div>
  `
  const roomInput = document.querySelector<HTMLInputElement>('#room-input')!
  roomInput.value = new URLSearchParams(location.search).get('room')?.toUpperCase() || ''
  document.querySelector('#play-button')?.addEventListener('click', () => connect(roomInput.value.trim().toUpperCase() || randomRoom()))
  roomInput.addEventListener('keydown', event => { if (event.key === 'Enter') connect(roomInput.value.trim().toUpperCase() || randomRoom()) })
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.addEventListener('click', () => doAction(button.dataset.action as Action)))
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => {
    const key = button.dataset.move!
    const down = (event: Event) => { event.preventDefault(); held.add(key) }
    const up = (event: Event) => { event.preventDefault(); held.delete(key) }
    button.addEventListener('pointerdown', down)
    button.addEventListener('pointerup', up)
    button.addEventListener('pointerleave', up)
  })
}

function connect(room: string): void {
  const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim()
  const endpoint = configured || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
  const url = new URL(endpoint)
  url.searchParams.set('room', room)
  socket?.close()
  socket = new WebSocket(url)
  document.querySelector('#title-screen')?.classList.remove('active')
  document.querySelector('#game-screen')?.classList.add('active')
  setConnection('подключение…', 'pending')
  socket.addEventListener('open', () => { setConnection('онлайн', 'online'); toast(`Ферма ${room} готова — пригласите второго игрока`) })
  socket.addEventListener('message', event => {
    try { handleServerMessage(JSON.parse(String(event.data)) as ServerMessage) } catch { toast('Сервер прислал непонятный ответ') }
  })
  socket.addEventListener('close', () => setConnection('переподключитесь', 'offline'))
  socket.addEventListener('error', () => { setConnection('ошибка соединения', 'offline'); toast('Не удалось подключиться к серверу') })
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === 'error') { toast(message.message); return }
  if (message.type === 'welcome') {
    playerId = message.id
    state = message.state
    const me = state.players.find(player => player.id === playerId)
    if (me) localPosition.set(me.x, me.z)
    renderState()
    return
  }
  if (message.type === 'state') {
    const oldMessage = state?.message
    state = message.state
    const me = state.players.find(player => player.id === playerId)
    if (me && (performance.now() - lastStateAt > 450 || localPosition.distanceTo(new THREE.Vector2(me.x, me.z)) > 2.2)) localPosition.set(me.x, me.z)
    if (state.message && state.message !== oldMessage) toast(state.message)
    renderState()
  }
  lastStateAt = performance.now()
}

function setConnection(label: string, mode: 'online' | 'pending' | 'offline'): void {
  const dot = document.querySelector('#connection-dot')
  const text = document.querySelector('#connection-label')
  if (dot) dot.className = mode
  if (text) text.textContent = label
}

function doAction(action: Action): void {
  send({ type: 'action', action, crop: selectedCrop })
}

function renderState(): void {
  if (!state) return
  const currentState = state
  document.querySelector('#hud-room')!.textContent = state.room
  document.querySelector('#hud-day')!.textContent = `${state.day} · ${formatTime(state.minutes)}`
  document.querySelector('#hud-money')!.textContent = `${state.money} 🪙`
  document.querySelector('#goal-text')!.textContent = `Накопите ${state.goal.target} монет · ${state.goal.progress}/${state.goal.target}`
  document.querySelector<HTMLDivElement>('#goal-progress')!.style.width = `${Math.min(100, state.goal.progress / state.goal.target * 100)}%`
  document.querySelector('#players-list')!.innerHTML = state.players.map(player => `<div class="player-row"><i style="background:#${player.color.slice(1)}"></i><span>${escapeHtml(player.name)}${player.id === playerId ? ' · вы' : ''}</span><em>${player.sleeping ? 'спит' : 'в поле'}</em></div>`).join('')
  document.querySelector('#seed-list')!.innerHTML = CROP_KEYS.map((key, index) => `<button class="seed ${key === selectedCrop ? 'selected' : ''}" data-seed="${key}"><b>${index + 1}</b><span>${CROP_DEFS[key].icon} ${CROP_DEFS[key].label}</span><em>${currentState.players.find(player => player.id === playerId)?.seeds[key] ?? 0}</em></button>`).join('')
  document.querySelectorAll<HTMLButtonElement>('[data-seed]').forEach(button => button.addEventListener('click', () => { selectedCrop = button.dataset.seed as CropKind; renderState() }))
  document.querySelector('#event-log')!.innerHTML = state.log.slice(-4).reverse().map(line => `<p>${escapeHtml(line)}</p>`).join('')
  renderWorld()
}

function formatTime(minutes: number): string { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` }

function setupScene(): void {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xbfe9d3)
  camera = new THREE.OrthographicCamera(-15, 15, 10, -10, 0.1, 100)
  camera.position.set(0, 24, 17)
  camera.lookAt(0, 0, 0)
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  clock = new THREE.Clock()
  farmGroup = new THREE.Group()
  scene.add(farmGroup)
  scene.add(new THREE.HemisphereLight(0xfff4d6, 0x527d6c, 2.6))
  const sun = new THREE.DirectionalLight(0xfff1c5, 3.2)
  sun.position.set(-8, 18, 8)
  sun.castShadow = true
  scene.add(sun)
  createFarmDecor()
  window.addEventListener('resize', resize)
  resize()
  window.requestAnimationFrame(frame)
}

function meshBox(size: [number, number, number], color: number, position: [number, number, number], radius = 0.08): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(...size)
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.92 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  if (radius) mesh.geometry.translate(0, radius, 0)
  return mesh
}

function createFarmDecor(): void {
  const ground = meshBox([30, 0.4, 20], 0x74b676, [0, -0.35, 0], 0)
  farmGroup.add(ground)
  const path = meshBox([30, 0.08, 2.6], 0xe9c88f, [0, -0.1, 1.8], 0)
  farmGroup.add(path)
  const pond = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x5bb6c9, roughness: 0.2, metalness: 0.05 }))
  pond.rotation.x = Math.PI / 2
  pond.position.set(10, 0.08, -5.7)
  farmGroup.add(pond)
  const house = new THREE.Group()
  house.add(meshBox([4.4, 2.2, 3.2], 0xffe8b5, [-10, 1.1, -4], 0))
  const roof = meshBox([5.1, 0.65, 3.8], 0xc85d4b, [-10, 2.5, -4], 0)
  roof.rotation.z = 0.02
  house.add(roof)
  house.add(meshBox([0.9, 1.5, 0.15], 0x5f4b46, [-10, 0.75, -2.36], 0))
  farmGroup.add(house)
  for (let x = -14; x <= 14; x += 2) {
    farmGroup.add(meshBox([0.22, 0.8, 0.22], 0x8b5e3c, [x, 0.4, -9.1], 0))
    if (x < 14) farmGroup.add(meshBox([2, 0.18, 0.18], 0xd29c6b, [x + 1, 0.65, -9.1], 0))
  }
  ;[
    [-12, 4], [-9, 6], [-6, -7], [7, 6.5], [12, 3.8], [13, -1], [-3, 7], [4, -6.2],
  ].forEach(([x, z], index) => addTree(x, z, index % 2 ? 0x2f8f59 : 0x3aa76d))
  ;[
    [-3, 5.3], [1, 6.5], [6, 5.2], [11, 7], [-13, -1.2], [13, 0.9], [2, -7.2],
  ].forEach(([x, z]) => addRock(x, z))
}

function addTree(x: number, z: number, color: number): void {
  const tree = new THREE.Group()
  tree.position.set(x, 0, z)
  tree.add(meshBox([0.55, 1.7, 0.55], 0x80513c, [0, 0.85, 0], 0))
  const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(1.35, 1), new THREE.MeshStandardMaterial({ color, roughness: 1 }))
  crown.position.y = 2.05
  crown.castShadow = true
  tree.add(crown)
  farmGroup.add(tree)
}

function addRock(x: number, z: number): void {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6, 0), new THREE.MeshStandardMaterial({ color: 0x80929a, roughness: 1 }))
  rock.position.set(x, 0.45, z)
  rock.scale.set(1.3, 0.75, 1)
  rock.castShadow = true
  farmGroup.add(rock)
}

function renderWorld(): void {
  if (!state) return
  cropMeshes.forEach(mesh => farmGroup.remove(mesh))
  cropMeshes.clear()
  state.crops.forEach(crop => {
    const patch = new THREE.Group()
    patch.position.set(crop.x, 0.02, crop.z)
    const soil = meshBox([1.55, 0.06, 1.25], 0x9a6b43, [0, 0, 0], 0)
    patch.add(soil)
    if (crop.kind) {
      const def = CROP_DEFS[crop.kind]
      const height = crop.ready ? 0.95 : 0.25 + Math.min(crop.growth / def.days, 0.85) * 0.55
      const plant = new THREE.Mesh(new THREE.CylinderGeometry(crop.ready ? 0.25 : 0.18, 0.38, height, 8), new THREE.MeshStandardMaterial({ color: crop.ready ? def.color : def.accent, roughness: 0.9 }))
      plant.position.y = height / 2 + 0.08
      plant.castShadow = true
      patch.add(plant)
      if (crop.ready) {
        const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), new THREE.MeshStandardMaterial({ color: def.color }))
        fruit.position.y = height + 0.18
        patch.add(fruit)
      }
    }
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.68, 0.75, 24), new THREE.MeshBasicMaterial({ color: crop.watered ? 0x6ccff6 : 0xf8e16c, transparent: true, opacity: 0.55, side: THREE.DoubleSide }))
    marker.rotation.x = -Math.PI / 2
    marker.position.y = 0.08
    patch.add(marker)
    farmGroup.add(patch)
    cropMeshes.set(crop.id, patch)
  })
  playerMeshes.forEach(mesh => farmGroup.remove(mesh))
  playerMeshes.clear()
  state.players.forEach(player => {
    const group = new THREE.Group()
    group.position.set(player.id === playerId ? localPosition.x : player.x, 0, player.id === playerId ? localPosition.y : player.z)
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), new THREE.MeshStandardMaterial({ color: player.color }))
    body.position.y = 0.65
    body.castShadow = true
    group.add(body)
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.42, 0.18, 12), new THREE.MeshStandardMaterial({ color: player.id === playerId ? 0xf4d35e : 0xf28482 }))
    hat.position.y = 1.2
    group.add(hat)
    farmGroup.add(group)
    playerMeshes.set(player.id, group)
  })
}

function resize(): void {
  const aspect = innerWidth / innerHeight
  camera.left = -15 * aspect
  camera.right = 15 * aspect
  camera.top = 10
  camera.bottom = -10
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight, false)
}

function movementVector(): THREE.Vector2 {
  const vector = new THREE.Vector2()
  if (held.has('w') || held.has('ArrowUp') || held.has('up')) vector.y -= 1
  if (held.has('s') || held.has('ArrowDown') || held.has('down')) vector.y += 1
  if (held.has('a') || held.has('ArrowLeft') || held.has('left')) vector.x -= 1
  if (held.has('d') || held.has('ArrowRight') || held.has('right')) vector.x += 1
  return vector.lengthSq() ? vector.normalize() : vector
}

let lastInput = 0
function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05)
  const move = movementVector()
  if (state && playerId) {
    localPosition.x = THREE.MathUtils.clamp(localPosition.x + move.x * dt * 4.2, -14.2, 14.2)
    localPosition.y = THREE.MathUtils.clamp(localPosition.y + move.y * dt * 4.2, -8.2, 8.2)
    const me = playerMeshes.get(playerId)
    if (me) me.position.set(localPosition.x, 0, localPosition.y)
    if (performance.now() - lastInput > 55) {
      send({ type: 'input', dx: move.x, dz: move.y, x: localPosition.x, z: localPosition.y })
      lastInput = performance.now()
    }
  }
  if (state) {
    state.players.forEach(player => {
      if (player.id === playerId) return
      const mesh = playerMeshes.get(player.id)
      if (mesh) { mesh.position.x = THREE.MathUtils.lerp(mesh.position.x, player.x, 0.25); mesh.position.z = THREE.MathUtils.lerp(mesh.position.z, player.z, 0.25) }
    })
  }
  renderer.render(scene, camera)
  window.requestAnimationFrame(frame)
}

window.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) return
  held.add(event.key)
  if (/^[1-8]$/.test(event.key)) { selectedCrop = CROP_KEYS[Number(event.key) - 1]; renderState() }
  if (event.key.toLowerCase() === 'e') doAction('talk')
  if (event.key.toLowerCase() === 'p') doAction('plant')
  if (event.key.toLowerCase() === 'h') doAction('harvest')
  if (event.key.toLowerCase() === 's') doAction('sell')
  if (event.key.toLowerCase() === 'z') doAction('sleep')
})
window.addEventListener('keyup', event => held.delete(event.key))

buildUi()
setupScene()
