// The M8 as the app knows it: the SDK client, the port to drive it while it is connected, the one
// task running on it, and whether it has another song loaded than the one shown. Shared by the
// connection, the live follow-up of its screen and the device tasks.

import type { M8Client } from '@yam8d/m8-sdk'
import type { M8Port } from '../m8/port'

/** What runs on the device: one thing at a time. */
export type DeviceTask = 'explore' | 'theme' | 'sync' | 'show'

export class DeviceSession {
  client          : M8Client | null = null
  /** Set while the M8 is connected. */
  port            : M8Port | null = null
  task            : DeviceTask | null = null
  /** The M8 has another song loaded than the one explored: nothing from the screen is merged. */
  otherSongLoaded = false

  /** The client to read the screen from; null while reads must wait (not connected, a task running, another song loaded). */
  readableClient(): M8Client | null {
    return this.client?.isConnected && !this.task && !this.otherSongLoaded ? this.client : null
  }
}
