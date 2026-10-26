/**
 * Client presentation values in one place. Gameplay rules (speed, arena size, bounce, score to
 * win) are owned by the server and arrive in `welcome.rules`; change them in
 * `server/authoritative_server.mjs`, and every client runs the new numbers.
 */
export const DEFAULT_CONFIG = {
  camera: {
    fov: 50,
    /** Camera position behind the player's own spawn, in metres. */
    height: 15,
    distance: 17,
    /** 0 keeps the camera fixed; 1 makes it follow the own ball fully. */
    follow: 0.25,
  },
  net: {
    /** Other balls are projected forward by their pose age (latency + time since receipt), at most this many seconds. */
    maxLead: 0.2,
    /** Time constant, in seconds, over which a correction from a new pose of another ball fades out. */
    smoothTime: 0.06,
    /** A correction longer than this, in metres (one ball diameter), jumps at once instead of fading. */
    snapDistance: 1.6,
  },
  look: {
    /** Fall animation after a ring out (cosmetic; the server referees the score). */
    fallGravity: 24,
    bumpShake: 0.5,
  },
} as const

// Presentation always reads active values here. Source defaults remain immutable for
// Tweak Reset and Save with Manus; Apply never writes source or local storage.
type MutableConfig<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends object ? MutableConfig<T[K]> : T[K] }
export const CONFIG: MutableConfig<typeof DEFAULT_CONFIG> = structuredClone(DEFAULT_CONFIG)
