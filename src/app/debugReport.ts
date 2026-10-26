// The global part of the debug log: what the page is running in, which permissions it holds,
// how it reaches the M8, the MIDI sync and the song. Sections are read when the log is
// exported, so they show the state at that moment. Also the page-wide watchers (errors,
// visibility) that write to the log.

import { getDeviceSupport, type M8Client } from '@yam8d/m8-sdk'
import type { MidiInfo } from '../m8/midiControl'
import { clip, type DebugLog } from '../model/debugLog'
import { grooveReports } from '../model/music/groove'
import { lastSongRow, type SongModel, usedItems } from '../model/song'
import { preferences } from './preferences'

/** What the sections read from the app. */
export interface DebugSources {
  client  : () => M8Client | null
  model   : () => SongModel
  mixer   : () => MidiInfo
  /** The app's own switches. */
  settings: () => Record<string, unknown>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Set by Vite from the installed SDK; absent in the tests. */
declare const __SDK_VERSION__ : string | undefined
const sdkVersion              = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : null

interface NavigatorExtras {
  deviceMemory? : number
  userAgentData?: { platform?: string; mobile?: boolean }
  serial?       : { getPorts(): Promise<{ getInfo(): { usbVendorId?: number; usbProductId?: number } }[]> }
  usb?          : { getDevices(): Promise<{ productName?: string; vendorId: number; productId: number; opened: boolean }[]> }
}

interface FeaturePolicy {
  allowsFeature(feature: string): boolean
}

const hex4 = (value: number | undefined): string | null => (value == null ? null : `0x${value.toString(16).padStart(4, '0')}`)

function environment() {
  const extras       = navigator as Navigator & NavigatorExtras
  const inside       = window.parent !== window
  let referrerOrigin : string | null = null
  try {
    referrerOrigin = document.referrer ? new URL(document.referrer).origin : null
  } catch {
    // Not a URL.
  }
  return {
    userAgent     : navigator.userAgent,
    platform      : extras.userAgentData?.platform ?? navigator.platform,
    language      : navigator.language,
    cores         : navigator.hardwareConcurrency,
    deviceMemoryGb: extras.deviceMemory ?? null,
    screen        : {
      width     : screen.width,
      height    : screen.height,
      pixelRatio: window.devicePixelRatio
    },
    viewport      : {
      width : window.innerWidth,
      height: window.innerHeight
    },
    secureContext : window.isSecureContext,
    online        : navigator.onLine,
    visibility    : document.visibilityState,
    inFrame       : inside,
    frameName     : window.name,
    origin        : location.origin,
    referrerOrigin,
    sdkVersion,
    development   : import.meta.env.DEV
  }
}

/** Web MIDI, mic, serial and USB: what the page may use, without asking for anything. */
async function permissions() {
  const query                         = async (descriptor: object): Promise<string> => {
    try {
      return (await navigator.permissions.query(descriptor as PermissionDescriptor)).state
    } catch (error) {
      return `unknown (${messageOf(error)})`
    }
  }
  const policy                        = (feature: string): boolean | null => {
    try {
      return (document as Document & { featurePolicy?: FeaturePolicy }).featurePolicy?.allowsFeature(feature) ?? null
    } catch {
      return null
    }
  }
  const extras                        = navigator as Navigator & NavigatorExtras
  const [midi, midiSysex, microphone] = await Promise.all([query({ name: 'midi' }), query({
    name : 'midi',
    sysex: true
  }), query({ name: 'microphone' })])
  return {
    midi         : {
      supported           : 'requestMIDIAccess' in navigator,
      permission          : midi,
      sysexPermission     : midiSysex,
      allowedByFramePolicy: policy('midi'),
      ports               : await midiPorts(midi === 'granted' || midiSysex === 'granted', midiSysex === 'granted')
    },
    audioInput   : {
      permission          : microphone,
      allowedByFramePolicy: policy('microphone')
    },
    serial       : {
      supported           : 'serial' in navigator,
      allowedByFramePolicy: policy('serial'),
      grantedPorts        : await grantedSerialPorts(extras)
    },
    usb          : {
      supported           : 'usb' in navigator,
      allowedByFramePolicy: policy('usb'),
      grantedDevices      : await grantedUsbDevices(extras)
    },
    deviceSupport: getDeviceSupport()
  }
}

/** The MIDI ports the browser lists. Only asked for when the permission is already granted: this never prompts. */
async function midiPorts(granted: boolean, sysex: boolean) {
  if (!granted) return 'not listed: the MIDI permission is not granted yet'
  if (!('requestMIDIAccess' in navigator)) return null
  try {
    const access   = await navigator.requestMIDIAccess({ sysex })
    // Not the port's `connection`: this access object is a fresh one, its ports always read closed.
    const describe = (port: MIDIPort) => ({
      name        : port.name,
      manufacturer: port.manufacturer,
      state       : port.state
    })
    return {
      inputs : [...access.inputs.values()].map(describe),
      outputs: [...access.outputs.values()].map(describe)
    }
  } catch (error) {
    return `not listed: ${messageOf(error)}`
  }
}

async function grantedSerialPorts(extras: NavigatorExtras) {
  try {
    return (await extras.serial?.getPorts())?.map((port) => {
      const { usbVendorId, usbProductId } = port.getInfo()
      return {
        vendorId : hex4(usbVendorId),
        productId: hex4(usbProductId)
      }
    }) ?? null
  } catch (error) {
    return `not listed: ${messageOf(error)}`
  }
}

async function grantedUsbDevices(extras: NavigatorExtras) {
  try {
    return (await extras.usb?.getDevices())?.map((device) => ({
      name     : device.productName ?? null,
      vendorId : hex4(device.vendorId),
      productId: hex4(device.productId),
      opened   : device.opened
    })) ?? null
  } catch (error) {
    return `not listed: ${messageOf(error)}`
  }
}

/** How the page reaches the M8: through yam8d, or on its own over serial, USB or Web MIDI. */
function connection(client: M8Client | null) {
  if (!client) return { client: null }
  const { state } = client
  return {
    mode           : client.mode,
    connected      : client.isConnected,
    deviceTransport: client.deviceTransport,
    audio          : client.isAudioConnected,
    deviceModel    : state.deviceModel,
    systemInfo     : state.systemInfo,
    fontMode       : state.fontMode,
    view           : state.viewName,
    viewTitle      : state.viewTitle,
    cursor         : state.cursorPos
  }
}

/** The song as explored: sizes, where it came from, the project settings, the grooves and what the exploration warned about. */
function song(model: SongModel) {
  const used = usedItems(model)
  return {
    name              : model.name,
    source            : model.source,
    capturedAt        : new Date(model.capturedAt).toISOString(),
    tempo             : model.tempo ?? null,
    rows              : lastSongRow(model) + 1,
    chains            : Object.keys(model.chains).length,
    phrases           : Object.keys(model.phrases).length,
    instruments       : {
      read: Object.keys(model.instruments).length,
      used: used.instruments.length
    },
    tables            : {
      read: Object.keys(model.tables).length,
      used: used.tables.length
    },
    scalesRead        : Object.keys(model.scales ?? {}).length,
    instrumentList    : Object.values(model.instruments).map((instrument) => ({
      id      : instrument.id,
      type    : instrument.type,
      name    : instrument.name,
      modsRead: instrument.mods != null
    })),
    project           : {
      transpose: model.projectTranspose ?? null,
      scale    : model.projectScale ?? null,
      key      : model.projectKey ?? null,
      groove   : model.projectGroove ?? null
    },
    grooves           : grooveReports(model),
    nonStandardGrooves: grooveReports(model).filter((groove) => !groove.standard).map((groove) => groove.id),
    themeRead         : model.theme != null,
    warnings          : model.warnings.map((warning) => clip(warning))
  }
}

/** MIDI SYNC OUT and the channels: what decides whether the playheads can follow the M8's clock. */
function midi(model: SongModel, mixer: MidiInfo) {
  const sync = model.midiSync ?? null
  return {
    songSettings          : sync,
    syncOutFollowsPlayback: sync?.syncOut == null ? null : sync.syncOut === 'CLK+TRANSP+SPP',
    muteSoloOutput        : mixer
  }
}

/** Registers every global section on `log`. */
export function registerDebugProviders(log: DebugLog, sources: DebugSources): void {
  log.provide('environment', environment)
  log.provide('permissions', permissions)
  log.provide('connection', () => connection(sources.client()))
  log.provide('midi', () => midi(sources.model(), sources.mixer()))
  log.provide('song', () => song(sources.model()))
  log.provide('settings', () => ({
    ...sources.settings(),
    dramatic    : preferences.dramatic.get(),
    playedNotes : preferences.playedNotes.get(),
    infoPinned  : preferences.infoPinned.get(),
    ccMapChannel: preferences.ccMapChannel.get()
  }))
}

/** The main thread stalling this long while the song plays delays the screen reads the playheads are corrected by. */
const LONG_TASK_MS = 150

/**
 * Errors the page throws, the page going to the background (the browser slows its timers
 * there: playheads drift), the 3D context being lost, and the main thread stalling while the
 * song plays.
 */
export function watchPage(log: DebugLog, isPlaying: () => boolean): void {
  window.addEventListener('error', (event) => {
    log.problem('error', event.message || 'script error', {
      file: event.filename ? event.filename.split('/').pop() : null,
      line: event.lineno
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    log.problem('unhandled-rejection', messageOf(event.reason))
  })
  document.addEventListener('visibilitychange', () => log.event('visibility', { state: document.visibilityState }))
  window.addEventListener('pagehide', () => log.event('pagehide'))
  // Context events do not bubble: caught on the way down.
  document.addEventListener('webglcontextlost', () => log.problem('webgl', 'the 3D context was lost'), true)
  document.addEventListener('webglcontextrestored', () => log.event('webgl-restored'), true)
  try {
    new PerformanceObserver((list) => {
      if (!isPlaying()) return
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_MS) log.throttled('long-task', 500, 'long-task', { ms: Math.round(entry.duration) })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    // Not offered by this browser.
  }
}
