// Device actions beyond the exploration: read the theme off the Theme View, put the M8
// cursor on a cell of the model, and fold what the M8 shows right now back into the model.

import {
  getSemanticContext,
  type M8Screen,
  type M8State,
  type M8Theme,
  M8_THEME_VIEW,
  parseGridScreen,
  parseThemeScreen,
  SCREEN_MARGIN,
} from '@yam8d/m8-sdk'
import { COLUMNS } from '../model/screens'
import { hex2, type SongModel } from '../model/song'
import {
  type DriverOptions,
  GRAPH_VIEWS,
  isPage,
  M8Driver,
  M8MoveError,
  readChain,
  readGroove,
  readInstrument,
  readPhrase,
  readProject,
  readSongRows,
  readTable,
  type ScreenView,
  titleOf,
  viewOf,
} from './driver'
import type { M8Port } from './port'

// ---------------------------------------------------------------------------
// Theme

/** Project row 20 holds SYSTEM SETTINGS, its row 7 EDIT THEME (measured on a Model:02, firmware 6.5). */
const SYSTEM_SETTINGS_CELL = { x: 14, y: 20 }
const EDIT_THEME_CELL = { x: 16, y: 7 }

async function waitViewName(port: M8Port, name: string, timeoutMs = 3000): Promise<M8State> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await port.getState()
    if (state.viewName === name) return state
    if (Date.now() > deadline) throw new M8MoveError(`expected the ${name} view, the M8 shows "${state.viewName ?? 'nothing'}"`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

/**
 * Opens System Settings > EDIT THEME from the Project view, reads the 13 colours and goes
 * back to the view it started from. Edit is only pressed after checking the cursor row
 * says what it should, so a moved layout stops the walk instead of changing a setting.
 */
export async function readDeviceTheme(port: M8Port, options: DriverOptions = {}): Promise<M8Theme> {
  const driver = new M8Driver(port, options)
  const start = (await port.getState()).viewName
  if (start !== M8_THEME_VIEW) {
    await driver.leaveSubViews()
    await port.navigateToView('project')
    await waitViewName(port, 'project')
    await driver.moveCursor(SYSTEM_SETTINGS_CELL.x, SYSTEM_SETTINGS_CELL.y)
    const onProject = await port.getState()
    if (!/SYSTEM/i.test(onProject.currentLine ?? '')) {
      throw new M8MoveError(`the Project row under the cursor reads "${onProject.currentLine ?? ''}", not SYSTEM SETTINGS`)
    }
    await driver.press(['edit'])
    await waitViewName(port, 'systemsettings')
    await driver.moveCursor(EDIT_THEME_CELL.x, EDIT_THEME_CELL.y)
    const onSettings = await port.getState()
    if (!/THEME/i.test(onSettings.currentLine ?? '')) {
      throw new M8MoveError(`the System Settings row under the cursor reads "${onSettings.currentLine ?? ''}", not THEME`)
    }
    await driver.press(['edit'])
    await waitViewName(port, M8_THEME_VIEW)
  }
  const view = await driver.settle((v) => parseThemeScreen(v.screen) != null, 'the theme colours', 3000)
  const theme = parseThemeScreen(view.screen) as M8Theme
  if (start !== M8_THEME_VIEW) {
    await driver.leaveSubViews()
    if (start && GRAPH_VIEWS.has(start)) await port.navigateToView(start).catch(() => false)
  }
  return theme
}

// ---------------------------------------------------------------------------
// MIDI sync (Project > MIDI SETTINGS, stored in each song)

/** What the explorer needs the M8 to send: clock (time base), transport (start/stop) and SPP (where). */
export const SYNC_OUT_TARGET = 'CLK+TRANSP+SPP'
/** SYNC OUT values in the order Edit+Right steps through them. */
const SYNC_OUT_STEPS = ['OFF', 'CLOCK', 'TRANSPORT', 'CLOCK+TRANSP', 'TRANSPORT+SPP', 'CLK+TRANSP+SPP']

const settingRow = (screen: M8Screen, label: string): { y: number; x: number; value: string } | null => {
  for (let y = 0; y < screen.lines.length; y += 1) {
    const line = (screen.lines[y] ?? '').slice(0, 31)
    const m = new RegExp(`^(\\s*${label}\\s+)(\\S.*?)\\s*$`, 'i').exec(line)
    if (m) return { y, x: m[1].length, value: m[2].toUpperCase() }
  }
  return null
}

/** The MIDI Settings values on screen, null when it is not the MIDI Settings view. */
export function readMidiSettings(screen: M8Screen): { syncIn: string | null; syncOut: string | null } | null {
  if (!/^MIDI SETTINGS/.test(titleOf(screen))) return null
  const out = settingRow(screen, 'SYNC OUT')
  if (!out) return null
  return { syncIn: settingRow(screen, 'SYNC IN')?.value ?? null, syncOut: out.value }
}

/** Project > MIDI SETTINGS: Edit is pressed on SETTINGS only once the cursor row says MIDI and the cell SETTINGS. */
async function openMidiSettings(port: M8Port, driver: M8Driver): Promise<ScreenView> {
  const here = await driver.read()
  if (readMidiSettings(here.screen)) return here
  await driver.leaveSubViews()
  await port.navigateToView('project')
  await waitViewName(port, 'project')
  const project = await driver.settle((v) => /^PROJECT/.test(v.title), 'the project view', 3000)
  const y = project.screen.lines.findIndex((l) => /^\s*MIDI\b/i.test(l))
  const x = y >= 0 ? (project.screen.lines[y] ?? '').toUpperCase().indexOf('SETTINGS') : -1
  if (x < 0) throw new M8MoveError('the Project view shows no MIDI SETTINGS entry')
  await driver.moveCursor(x, y)
  const state = await port.getState()
  if (!/MIDI/i.test(state.currentLine ?? '') || !/SETTINGS/i.test(state.textUnderCursor ?? '')) {
    throw new M8MoveError(`the cursor is on "${state.textUnderCursor ?? ''}", not MIDI SETTINGS`)
  }
  await driver.press(['edit'])
  return driver.settle((v) => readMidiSettings(v.screen) != null, 'the MIDI Settings view', 3000)
}

/** Reads SYNC IN / OUT from the MIDI Settings, then goes back to the Song view. */
export async function readMidiSync(port: M8Port, options: DriverOptions = {}): Promise<{ syncIn: string | null; syncOut: string | null }> {
  const driver = new M8Driver(port, options)
  const view = await openMidiSettings(port, driver)
  const sync = readMidiSettings(view.screen) as { syncIn: string | null; syncOut: string | null }
  await driver.leaveSubViews()
  await driver.gotoView('song').catch(() => {})
  return sync
}

/**
 * Sets SYNC OUT to CLK+TRANSP+SPP: Edit held, Right tapped until the value reads it (the
 * value is checked after every step), then released. Changes the song's MIDI Settings;
 * they are kept on the card only when the song is saved.
 */
export async function setMidiSyncOut(port: M8Port, options: DriverOptions = {}): Promise<string> {
  const driver = new M8Driver(port, options)
  let view = await openMidiSettings(port, driver)
  const row = settingRow(view.screen, 'SYNC OUT')
  if (!row) throw new M8MoveError('no SYNC OUT row on the MIDI Settings view')
  await driver.moveCursor(row.x, row.y)
  const under = (await port.getState()).textUnderCursor?.toUpperCase() ?? ''
  if (!under || !row.value.startsWith(under.split(' ')[0])) {
    throw new M8MoveError(`the cursor is on "${under}", not the SYNC OUT value`)
  }
  let value = row.value
  const from = SYNC_OUT_STEPS.indexOf(value)
  const steps = from >= 0 ? SYNC_OUT_STEPS.length - 1 - from : SYNC_OUT_STEPS.length
  try {
    await port.keyDown(['edit'])
    await driver.sleep(200)
    for (let i = 0; i < steps && value !== SYNC_OUT_TARGET; i += 1) {
      const before = value
      await port.keyDown(['edit', 'right'])
      await driver.sleep(80)
      await port.keyDown(['edit'])
      view = await driver.settle((v) => (readMidiSettings(v.screen)?.syncOut ?? before) !== before, 'the SYNC OUT value to change', 1200)
      value = readMidiSettings(view.screen)?.syncOut ?? before
    }
  } finally {
    await driver.sleep(120)
    await port.keyUp()
  }
  if (value !== SYNC_OUT_TARGET) throw new M8MoveError(`SYNC OUT reads ${value}`)
  await driver.leaveSubViews()
  await driver.gotoView('song').catch(() => {})
  return value
}

// ---------------------------------------------------------------------------
// Show a cell of the model on the M8

export type PhraseColumn = 'note' | 'vel' | 'inst' | 'fx1cmd' | 'fx1val' | 'fx2cmd' | 'fx2val' | 'fx3cmd' | 'fx3val'
export type TableColumn = 'transpose' | 'volume' | 'fx1cmd' | 'fx1val' | 'fx2cmd' | 'fx2val' | 'fx3cmd' | 'fx3val'

export type DeviceTarget =
  | { kind: 'song'; songRow: number; track: number }
  | { kind: 'chain'; songRow: number; track: number; chainRow: number }
  | { kind: 'step'; songRow: number; track: number; chainRow: number; step: number; column: PhraseColumn }
  | { kind: 'instrument'; inst: number }
  | { kind: 'table'; table: number; row: number; column: TableColumn }

/** Schema x of a phrase / table column. */
export function phraseColumnX(column: PhraseColumn): number {
  const lane = /^fx(\d)(cmd|val)$/.exec(column)
  if (lane) return (lane[2] === 'cmd' ? COLUMNS.phrase.fx : COLUMNS.phrase.fxVal)[Number(lane[1]) - 1]
  return COLUMNS.phrase[column as 'note' | 'vel' | 'inst']
}

export function tableColumnX(column: TableColumn): number {
  const lane = /^fx(\d)(cmd|val)$/.exec(column)
  if (lane) return (lane[2] === 'cmd' ? COLUMNS.table.fx : COLUMNS.table.fxVal)[Number(lane[1]) - 1]
  return COLUMNS.table[column as 'transpose' | 'volume']
}

const gridRowY = (view: ScreenView, viewName: string, row: number): number => {
  const hit = parseGridScreen(viewName, view.screen).find((r) => r.rowIndex === row)
  if (!hit) throw new M8MoveError(`row ${row.toString(16)} is not on the ${viewName} screen`)
  return hit.screenRow
}

export async function showOnDevice(port: M8Port, model: SongModel, target: DeviceTarget, options: DriverOptions = {}): Promise<void> {
  const driver = new M8Driver(port, options)
  await driver.leaveSubViews()
  if (target.kind === 'instrument' || target.kind === 'table') {
    const viaInstrument = target.kind === 'instrument' || (target.table < 0x80 && model.instruments[target.table])
    if (viaInstrument) {
      const id = target.kind === 'instrument' ? target.inst : target.table
      await driver.stepTo('inst', id, await driver.gotoView('inst'))
      if (target.kind === 'instrument') return
      await driver.press(['shift', 'right'])
    } else {
      await driver.stepTo('table', target.table, await driver.gotoView('table'))
    }
    const tv = await driver.settle((v) => isPage(v, 'table', target.table), `table ${hex2(target.table)}`)
    await driver.moveCursor(tableColumnX(target.column) + SCREEN_MARGIN, gridRowY(tv, 'table', target.row))
    return
  }

  await driver.gotoView('song')
  await driver.songCursorTo(target.songRow, target.track)
  if (target.kind === 'song') return
  const chainId = model.song[target.songRow]?.[target.track]
  if (chainId == null) throw new M8MoveError('that song cell is empty')
  await driver.press(['shift', 'right'])
  const cv = await driver.settle((v) => isPage(v, 'chain', chainId), `chain ${hex2(chainId)}`)
  await driver.moveCursor(COLUMNS.chain.phrase + SCREEN_MARGIN, gridRowY(cv, 'chain', target.chainRow))
  if (target.kind === 'chain') return
  const phraseId = model.chains[chainId]?.rows[target.chainRow]?.phrase
  if (phraseId == null) throw new M8MoveError('that chain row is empty')
  await driver.press(['shift', 'right'])
  const pv = await driver.settle((v) => isPage(v, 'phrase', phraseId), `phrase ${hex2(phraseId)}`)
  await driver.moveCursor(phraseColumnX(target.column) + SCREEN_MARGIN, gridRowY(pv, 'phrase', target.step))
}

// ---------------------------------------------------------------------------
// Live: what the M8 shows now

/** Where the M8 cursor is, in model terms. */
export interface DeviceFocus {
  view: ScreenView['kind']
  id: number | null
  /** Row index under the cursor (song row, chain row, step, table row). */
  row: number | null
  /** Field key under the cursor ('note', 'fx2val', 'track3', ...). */
  column: string | null
}

export function deviceFocus(state: M8State, screen: M8Screen): DeviceFocus | null {
  const view = viewOf(screen)
  if (view.kind === 'other') return null
  const ctx = getSemanticContext(state, screen)
  return { view: view.kind, id: view.id, row: ctx?.row?.rowIndex ?? null, column: ctx?.activeField?.key ?? null }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Whether the screen shows another song than the model: on the Project view another name,
 * on the Song view more than a quarter of the visible song cells (at least 5) different.
 * Null when the screen cannot tell (other views, half-drawn screens).
 */
export function isOtherSong(model: SongModel, screen: M8Screen): boolean | null {
  const project = readProject(screen)
  if (project) return project.name != null && model.name != null ? project.name !== model.name : null
  const view = viewOf(screen)
  if (!isPage(view, 'song')) return null
  let cells = 0
  let different = 0
  for (const r of readSongRows(view)) {
    r.chains.forEach((chain, t) => {
      const known = model.song[r.row]?.[t] ?? null
      if (chain == null && known == null) return
      cells += 1
      if (chain !== known) different += 1
    })
  }
  return different >= 5 && different > cells * 0.25
}

/**
 * Folds a fully drawn song / chain / phrase / table / instrument / groove screen, or the
 * Project view's GROOVE, into the model. Returns true when the model changed (the M8 was
 * edited since the exploration).
 */
export function absorbScreen(model: SongModel, screen: M8Screen): boolean {
  const project = readProject(screen)
  if (project) {
    if (project.groove == null || project.groove === model.projectGroove) return false
    model.projectGroove = project.groove
    return true
  }
  const view = viewOf(screen)
  if (!isPage(view, view.kind)) return false
  switch (view.kind) {
    case 'song': {
      let changed = false
      for (const r of readSongRows(view)) {
        if (r.row >= model.song.length && r.chains.every((c) => c == null)) continue
        if (!same(model.song[r.row], r.chains)) {
          for (let i = model.song.length; i < r.row; i += 1) model.song[i] = Array(8).fill(null)
          model.song[r.row] = r.chains
          changed = true
        }
      }
      return changed
    }
    case 'chain': {
      const chain = readChain(view)
      if (!chain || same(model.chains[chain.id], chain)) return false
      model.chains[chain.id] = chain
      return true
    }
    case 'phrase': {
      const phrase = readPhrase(view)
      if (!phrase || same(model.phrases[phrase.id], phrase)) return false
      model.phrases[phrase.id] = phrase
      return true
    }
    case 'table': {
      const table = readTable(view)
      if (!table || same(model.tables[table.id], table)) return false
      model.tables[table.id] = table
      return true
    }
    case 'groove': {
      const groove = readGroove(view)
      if (!groove || same(model.grooves?.[groove.id], groove)) return false
      model.grooves = { ...model.grooves, [groove.id]: groove }
      return true
    }
    case 'inst': {
      const inst = readInstrument(view)
      const known = model.instruments[view.id as number]
      if (!inst || (known && known.name === inst.name && known.type === inst.type)) return false
      model.instruments[inst.id] = { ...inst, lines: inst.lines }
      return true
    }
    default:
      return false
  }
}
