// What the explorer needs from the M8: the SDK client in the app, a fake M8 in the tests.

import type { M8Client, M8KeyName, M8Screen, M8ScreenCells, M8State } from '@yam8d/m8-sdk'

export interface M8Port {
  getScreen(): Promise<M8Screen>
  /** Null when the host cannot report colours (yam8d before SDK 0.5). */
  getScreenCells(): Promise<M8ScreenCells | null>
  getState(): Promise<M8State>
  press(keys: M8KeyName[]): Promise<void>
  /** Holds exactly these keys down (the others are released). */
  keyDown(keys: M8KeyName[]): Promise<void>
  /** Releases every key. */
  keyUp(): Promise<void>
  navigateTo(x: number, y: number): Promise<void>
  navigateToView(view: string): Promise<boolean>
}

export class M8TimeoutError extends Error {}

/** yam8d's navigateToView only answers once the view changes, so every call is bounded. */
export const withTimeout          = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new M8TimeoutError(`${what} did not answer within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

const CALL_TIMEOUT_MS             = 4000
const NAVIGATE_TO_VIEW_TIMEOUT_MS = 6000

/** Adapts the SDK client to the port, every call bounded by a timeout. */
export function clientPort(client: M8Client): M8Port {
  /** Turned off once the host fails to report colours (yam8d before SDK 0.5). */
  let cellsSupported = true
  return {
    getScreen     : () => withTimeout(client.getScreen(), CALL_TIMEOUT_MS, 'getScreen'),
    getScreenCells: async () => {
      if (!cellsSupported) return null
      try {
        return await withTimeout(client.getScreenCells(), CALL_TIMEOUT_MS, 'getScreenCells')
      } catch {
        cellsSupported = false
        return null
      }
    },
    getState      : () => withTimeout(client.fetchState(), CALL_TIMEOUT_MS, 'getState'),
    press         : (keys) => withTimeout(client.sendKeyPress(keys), CALL_TIMEOUT_MS, `keys ${keys.join('+')}`),
    keyDown       : (keys) => withTimeout(client.sendKeyDown(keys), CALL_TIMEOUT_MS, `hold ${keys.join('+')}`),
    keyUp         : () => withTimeout(client.sendKeyUp(), CALL_TIMEOUT_MS, 'release keys'),
    navigateTo    : (x, y) => withTimeout(client.navigateTo(x, y), CALL_TIMEOUT_MS, `navigateTo(${x}, ${y})`),
    navigateToView: (view) => withTimeout(client.navigateToView(view), NAVIGATE_TO_VIEW_TIMEOUT_MS, `navigateToView(${view})`)
  }
}
