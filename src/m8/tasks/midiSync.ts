// The song's MIDI sync output (Project > MIDI SETTINGS, stored in each song): read SYNC OUT,
// and set it to what the explorer needs to follow playback.

import type { M8Screen } from '@yam8d/m8-sdk'
import type { MidiSync } from '../../model/song'
import { type DriverOptions, M8Driver, M8MoveError } from '../driver'
import type { M8Port } from '../port'
import { type ScreenView, titleOf } from '../screen/screenReader'

/** What the explorer needs the M8 to send: clock (time base), transport (start/stop) and SPP (where). */
export const SYNC_OUT_TARGET = 'CLK+TRANSP+SPP'
/** SYNC OUT values in the order Edit+Right steps through them. */
const SYNC_OUT_VALUES        = ['OFF', 'CLOCK', 'TRANSPORT', 'CLOCK+TRANSP', 'TRANSPORT+SPP', 'CLK+TRANSP+SPP']

const MIDI_SETTINGS_TIMEOUT_MS   = 3000
const SYNC_OUT_CHANGE_TIMEOUT_MS = 1200
/** Waits around the Edit+Right taps, so the M8 sees a held Edit and each Right. */
const EDIT_HOLD_MS               = 200
const RIGHT_TAP_MS               = 80
const RELEASE_WAIT_MS            = 120
/** Settings labels and values sit left of this screen column. */
const SETTINGS_WIDTH             = 31

interface SettingRow {
  y    : number
  /** Screen x of the value. */
  x    : number
  value: string
}

function settingRow(screen: M8Screen, label: string): SettingRow | null {
  const pattern = new RegExp(`^(\\s*${label}\\s+)(\\S.*?)\\s*$`, 'i')
  for (let y = 0; y < screen.lines.length; y += 1) {
    const match = pattern.exec((screen.lines[y] ?? '').slice(0, SETTINGS_WIDTH))
    if (match) return {
      y,
      x    : match[1].length,
      value: match[2].toUpperCase()
    }
  }
  return null
}

/** The MIDI Settings values on screen, null when it is not the MIDI Settings view. */
export function readMidiSettings(screen: M8Screen): MidiSync | null {
  if (!/^MIDI SETTINGS/.test(titleOf(screen))) return null
  const syncOut = settingRow(screen, 'SYNC OUT')
  if (!syncOut) return null
  return {
    syncIn : settingRow(screen, 'SYNC IN')?.value ?? null,
    syncOut: syncOut.value
  }
}

/** Project > MIDI SETTINGS: Edit is pressed on SETTINGS only once the cursor row says MIDI and the cell SETTINGS. */
async function openMidiSettings(port: M8Port, driver: M8Driver): Promise<ScreenView> {
  const here = await driver.read()
  if (readMidiSettings(here.screen)) return here
  await driver.leaveSubViews()
  await port.navigateToView('project')
  await driver.waitForViewName('project')
  const project = await driver.settle((view) => /^PROJECT/.test(view.title), 'the project view', MIDI_SETTINGS_TIMEOUT_MS)
  const y       = project.screen.lines.findIndex((line) => /^\s*MIDI\b/i.test(line))
  const x       = y >= 0 ? (project.screen.lines[y] ?? '').toUpperCase().indexOf('SETTINGS') : -1
  if (x < 0) throw new M8MoveError('the Project view shows no MIDI SETTINGS entry')
  await driver.moveCursor(x, y)
  const state = await port.getState()
  if (!/MIDI/i.test(state.currentLine ?? '') || !/SETTINGS/i.test(state.textUnderCursor ?? '')) {
    throw new M8MoveError(`the cursor is on "${state.textUnderCursor ?? ''}", not MIDI SETTINGS`)
  }
  await driver.press(['edit'])
  return driver.settle((view) => readMidiSettings(view.screen) != null, 'the MIDI Settings view', MIDI_SETTINGS_TIMEOUT_MS)
}

async function backToSong(driver: M8Driver): Promise<void> {
  await driver.leaveSubViews()
  await driver.goToView('song').catch(() => {})
}

/** Reads SYNC IN / OUT from the MIDI Settings, then goes back to the Song view. */
export async function readMidiSync(port: M8Port, options: DriverOptions = {}): Promise<MidiSync> {
  const driver = new M8Driver(port, options)
  const view   = await openMidiSettings(port, driver)
  const sync   = readMidiSettings(view.screen) as MidiSync
  await backToSong(driver)
  return sync
}

/**
 * Sets SYNC OUT to CLK+TRANSP+SPP: Edit held, Right tapped until the value reads it (the
 * value is checked after every step), then released. Changes the song's MIDI Settings;
 * they are kept on the card only when the song is saved.
 */
export async function setMidiSyncOut(port: M8Port, options: DriverOptions = {}): Promise<string> {
  const driver = new M8Driver(port, options)
  const view   = await openMidiSettings(port, driver)
  const row    = settingRow(view.screen, 'SYNC OUT')
  if (!row) throw new M8MoveError('no SYNC OUT row on the MIDI Settings view')
  await driver.moveCursor(row.x, row.y)
  const underCursor = (await port.getState()).textUnderCursor?.toUpperCase() ?? ''
  if (!underCursor || !row.value.startsWith(underCursor.split(' ')[0])) {
    throw new M8MoveError(`the cursor is on "${underCursor}", not the SYNC OUT value`)
  }
  let value      = row.value
  const position = SYNC_OUT_VALUES.indexOf(value)
  const maxSteps = position >= 0 ? SYNC_OUT_VALUES.length - 1 - position : SYNC_OUT_VALUES.length
  try {
    await port.keyDown(['edit'])
    await driver.sleep(EDIT_HOLD_MS)
    for (let step = 0; step < maxSteps && value !== SYNC_OUT_TARGET; step += 1) {
      const before = value
      await port.keyDown(['edit', 'right'])
      await driver.sleep(RIGHT_TAP_MS)
      await port.keyDown(['edit'])
      const changed = await driver.settle(
        (v) => (readMidiSettings(v.screen)?.syncOut ?? before) !== before,
        'the SYNC OUT value to change',
        SYNC_OUT_CHANGE_TIMEOUT_MS,
      )
      value         = readMidiSettings(changed.screen)?.syncOut ?? before
    }
  } finally {
    await driver.sleep(RELEASE_WAIT_MS)
    await port.keyUp()
  }
  if (value !== SYNC_OUT_TARGET) throw new M8MoveError(`SYNC OUT reads ${value}`)
  await backToSong(driver)
  return value
}
