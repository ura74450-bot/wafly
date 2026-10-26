import { generateRoom, sanitizeRoom, validRoom } from './protocol'

/**
 * Room codes are public invitations carried in `?room=`. The resume token is private: it lives in
 * this tab's sessionStorage only, bound to the endpoint that issued it, and is never logged.
 */
const resumeKey = (room: string) => `ring_out_resume_${room}`

/** The room in `?room=`, or a new code written back to the address bar so it can be shared. */
export function resolveRoom(): string {
  const requested = sanitizeRoom(new URLSearchParams(location.search).get('room'))
  if (validRoom(requested)) return requested
  const room = generateRoom()
  writeRoom(room)
  return room
}

export function writeRoom(room: string): void {
  history.replaceState(history.state, '', inviteUrl(room))
}

export function inviteUrl(room: string): string {
  const url = new URL(location.href)
  url.searchParams.set('room', room)
  url.hash = ''
  return url.href
}

export function loadResume(room: string, endpoint: string): string {
  try {
    const value = JSON.parse(sessionStorage.getItem(resumeKey(room)) ?? '') as { endpoint?: unknown; token?: unknown }
    return value.endpoint === endpoint && typeof value.token === 'string' && value.token.length <= 128 ? value.token : ''
  } catch {
    return ''
  }
}

export function storeResume(room: string, endpoint: string, token: string): void {
  try {
    if (token) sessionStorage.setItem(resumeKey(room), JSON.stringify({ endpoint, token }))
    else sessionStorage.removeItem(resumeKey(room))
  } catch {
    // Private mode: the seat is simply not resumable after a reload.
  }
}

export function socketUrl(endpoint: string, room: string, resume: string): string {
  return `${endpoint}?room=${encodeURIComponent(room)}${resume ? `&resume=${encodeURIComponent(resume)}` : ''}`
}
