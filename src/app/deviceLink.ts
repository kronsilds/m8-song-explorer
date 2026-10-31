// The connection to the M8 through the SDK: inside yam8d through yam8d's connection, on its own
// page straight to the device (Connect M8, which needs a click for the browser's device picker).
// The HUD's status line says how the M8 is connected.

import { createM8ClientSync, type M8Client } from '@yam8d/m8-sdk'
import { clientPort, withTimeout } from '../m8/port'
import { debugLog } from '../model/debugLog'
import type { Hud } from '../ui/hud'
import type { DeviceSession } from './deviceSession'
import { messageOf } from './errorText'
import type { PlaybackFeed } from './playbackFeed'

const HANDSHAKE_TIMEOUT_MS = 6000

/** The status line while the M8 is connected: the model, and how a standalone page reaches it. */
export function connectedStatus(client: M8Client): string {
  const how = client.mode === 'standalone' ? ` · ${client.deviceTransport ?? 'direct'}${client.isAudioConnected ? ' + audio' : ''}` : ''
  return `M8 connected · ${client.state.deviceModel ?? 'device'}${how}`
}

/** What the connection tells the app. */
export interface DeviceLinkHooks {
  /** The M8 did something that may change what it shows: read its screen soon. */
  activity(): void
  /** The M8 came (the session's port is set). */
  up(): void
  /** The M8 went (the session's port is cleared). */
  down(): void
}

export class DeviceLink {
  constructor(
    private readonly session: DeviceSession,
    private readonly hud: Hud,
    private readonly playback: PlaybackFeed,
    private readonly hooks: DeviceLinkHooks,
  ) {}

  /** Opens the SDK client (yam8d's handshake, or a device the page was granted before) and listens to it. */
  async connect(): Promise<void> {
    const { hud, session, playback, hooks } = this
    const inFrame                           = window.parent !== window
    hud.setStatus(inFrame ? 'Connecting to yam8d…' : 'Looking for the M8…', 'busy')
    // Inside yam8d the SDK uses yam8d's connection; on its own the page connects to the M8 itself.
    const { client, connect } = createM8ClientSync()
    const asked               = performance.now()
    try {
      await withTimeout(connect(), HANDSHAKE_TIMEOUT_MS, inFrame ? 'the SDK handshake' : 'the M8')
      debugLog.provide('handshake', {
        ok  : true,
        ms  : Math.round(performance.now() - asked),
        mode: client.mode
      })
    } catch (error) {
      debugLog.provide('handshake', {
        ok   : false,
        ms   : Math.round(performance.now() - asked),
        error: messageOf(error)
      })
      debugLog.problem('handshake', messageOf(error))
      hud.setStatus('Not connected · this page could not reach yam8d')
      return
    }
    session.client = client
    const activity = () => hooks.activity()
    client.onViewChange(activity)
    client.onCursorMove(activity)
    client.onTextUpdate(activity)
    client.onStateChange(activity)
    // Option+Up/Down between two repeats of a phrase only moves the '<': no view, cursor or text change.
    client.onKeyPress(activity)
    playback.onChainPosition = activity
    // The model arrives with the M8's first system message, after the connection itself.
    client.onStateChange(() => {
      if (session.port && !session.task && !session.otherSongLoaded) hud.setStatus(connectedStatus(client), 'ok')
    })
    playback.listenToClock(client)
    client.onConnectionChange((connected) => (connected ? this.deviceUp(client) : this.deviceDown(client)))
    if (client.isConnected) this.deviceUp(client)
    else this.deviceDown(client)
    void playback.poll()
  }

  /** Standalone: connects the M8 (the device picker needs this click) or disconnects it. Audio comes along when the M8 offers it. */
  async toggleDevice(): Promise<void> {
    const client = this.session.client
    if (!client || this.session.task) return
    try {
      if (client.isConnected) {
        await client.disconnectDevice()
        return
      }
      this.hud.setStatus('Connecting to the M8…', 'busy')
      await client.connectDevice({ audio: true })
      if (!client.isAudioConnected)
        this.hud.notify('Connected without sound: no M8 audio input was found, or audio permission was refused', 'warn', 7000)
      this.deviceUp(client)
    } catch (error) {
      this.deviceDown(client)
      // Closing the browser's picker is not an error worth showing.
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        debugLog.event('connect-cancelled')
      } else {
        debugLog.problem('connect', messageOf(error))
        this.hud.notify(`Could not connect to the M8: ${messageOf(error)}`, 'warn', 7000)
      }
    }
  }

  private deviceUp(client: M8Client): void {
    debugLog.event('connection', {
      up         : true,
      mode       : client.mode,
      transport  : client.deviceTransport,
      audio      : client.isAudioConnected,
      deviceModel: client.state.deviceModel
    })
    this.session.port = clientPort(client)
    this.hud.setStatus(connectedStatus(client), 'ok')
    this.hud.setButton('device', {
      hidden: client.mode !== 'standalone',
      label : 'Disconnect M8'
    })
    this.hooks.up()
    void this.playback.enableClock(client)
  }

  private deviceDown(client: M8Client): void {
    debugLog.event('connection', {
      up  : false,
      mode: client.mode
    })
    this.session.port = null
    if (client.mode === 'standalone') {
      this.hud.setStatus('Standalone · Connect M8 (disconnect it in yam8d first)')
      this.hud.setButton('device', {
        hidden: false,
        label : 'Connect M8'
      })
    } else {
      this.hud.setStatus('Not connected · yam8d has no M8')
    }
    this.hooks.down()
  }
}
