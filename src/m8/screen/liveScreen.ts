// What the M8 shows right now, compared with the explored song: where its cursor is, whether
// another song is loaded, and edits made on the device folded back into the model.

import { getSemanticContext, type M8Screen, type M8State, SCREEN_MARGIN } from '@yam8d/m8-sdk'
import { type SongModel, TRACKS } from '../../model/song'
import {
  isPage,
  readChain,
  readChainMarks,
  readGroove,
  readInstrument,
  readInstrumentMods,
  readPhrase,
  readProject,
  readScale,
  readSongRows,
  readTable,
  type ScreenView,
  viewOf,
} from './screenReader'

/** Where the M8 cursor is, in model terms. */
export interface DeviceFocus {
  view      : ScreenView['kind']
  id        : number | null
  /** Row index under the cursor (song row, chain row, step, table row). */
  row       : number | null
  /** Field key under the cursor ('note', 'fx2val', 'track3', ...). */
  column    : string | null
  /** The cursor cell, screen x without the margin and screen row. */
  cursor    : { x: number; y: number } | null
  /** Phrase view: its '<' marks (its chain position, and the chain row playing when another); empty elsewhere. */
  chainMarks: number[]
}

export function deviceFocus(state: M8State, screen: M8Screen): DeviceFocus | null {
  const view = viewOf(screen)
  if (view.kind === 'other') return null
  const context = getSemanticContext(state, screen)
  return {
    view      : view.kind,
    id        : view.id,
    row       : context?.row?.rowIndex ?? null,
    column    : context?.activeField?.key ?? null,
    cursor    : state.cursorPos ? {
      x: state.cursorPos.x - SCREEN_MARGIN,
      y: state.cursorPos.y
    } : null,
    chainMarks: readChainMarks(view)
  }
}

/** Song cells that must differ, as a count and as a share of the visible ones, for another song. */
const OTHER_SONG_MIN_CELLS = 5
const OTHER_SONG_MIN_SHARE = 0.25

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
  let compared  = 0
  let different = 0
  for (const reading of readSongRows(view)) {
    reading.chains.forEach((chain, track) => {
      const known = model.song[reading.row]?.[track] ?? null
      if (chain == null && known == null) return
      compared += 1
      if (chain !== known) different += 1
    })
  }
  return different >= OTHER_SONG_MIN_CELLS && different > compared * OTHER_SONG_MIN_SHARE
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Stores `item` under its id unless the model already holds the same; true when it changed. */
function storeIfChanged<T extends { id: number }>(items: Record<number, T>, item: T | null): boolean {
  if (!item || sameJson(items[item.id], item)) return false
  items[item.id] = item
  return true
}

/** Folds the song rows on screen into the model; true when any changed. */
function absorbSongRows(model: SongModel, view: ScreenView): boolean {
  let changed = false
  for (const reading of readSongRows(view)) {
    if (reading.row >= model.song.length && reading.chains.every((chain) => chain == null)) continue
    if (sameJson(model.song[reading.row], reading.chains)) continue
    for (let row = model.song.length; row < reading.row; row += 1) model.song[row] = Array(TRACKS).fill(null)
    model.song[reading.row] = reading.chains
    changed                 = true
  }
  return changed
}

/** An instrument counts as changed when any of its values did; its modulators are kept. */
function absorbInstrument(model: SongModel, view: ScreenView): boolean {
  const instrument = readInstrument(view)
  const known      = model.instruments[view.id as number]
  if (!instrument || (known && sameJson(known.lines, instrument.lines) && known.name === instrument.name && known.type === instrument.type)) return false
  model.instruments[instrument.id] = {
    ...instrument,
    mods: known?.mods
  }
  return true
}

/** The modulators of an instrument the model knows, when they changed. */
function absorbModulators(model: SongModel, view: ScreenView): boolean {
  const mods  = readInstrumentMods(view)
  const known = mods ? model.instruments[mods.id] : null
  if (!mods || !known || sameJson(known.mods, mods.lines)) return false
  model.instruments[mods.id] = {
    ...known,
    mods: mods.lines
  }
  return true
}

/**
 * A scale on the Scale view (its notes, offsets and name); the KEY it shows is the project's
 * global key, so a change of it is folded in too.
 */
function absorbScale(model: SongModel, view: ScreenView): boolean {
  const scale = readScale(view)
  if (!scale) return false
  const scales = { ...model.scales }
  let changed  = storeIfChanged(scales, scale)
  if (changed) model.scales = scales
  if (scale.key != null && scale.key !== model.projectKey) {
    model.projectKey = scale.key
    changed          = true
  }
  return changed
}

/** How each view kind folds into the model. */
const ABSORBERS: Partial<Record<ScreenView['kind'], (model: SongModel, view: ScreenView) => boolean>> = {
  song    : absorbSongRows,
  chain   : (model, view) => storeIfChanged(model.chains, readChain(view)),
  phrase  : (model, view) => storeIfChanged(model.phrases, readPhrase(view)),
  table   : (model, view) => storeIfChanged(model.tables, readTable(view)),
  groove  : (model, view) => {
    const grooves = { ...model.grooves }
    if (!storeIfChanged(grooves, readGroove(view))) return false
    model.grooves = grooves
    return true
  },
  scale   : absorbScale,
  inst    : absorbInstrument,
  instmods: absorbModulators
}

/** The Project view's TRANSPOSE, GROOVE and SCALE (number and key). */
function absorbProject(model: SongModel, project: NonNullable<ReturnType<typeof readProject>>): boolean {
  let changed = false
  const set   = <K extends 'projectTranspose' | 'projectGroove' | 'projectScale' | 'projectKey'>(field: K, value: number | null): void => {
    if (value == null || model[field] === value) return
    model[field] = value
    changed      = true
  }
  set('projectTranspose', project.transpose)
  set('projectGroove', project.groove)
  set('projectScale', project.scale)
  set('projectKey', project.key)
  return changed
}

/**
 * Folds a fully drawn song / chain / phrase / table / instrument / modulators / groove / scale screen, or the
 * Project view's TRANSPOSE, GROOVE and SCALE, into the model. Returns true when the model changed (the M8 was
 * edited since the exploration).
 */
export function absorbScreen(model: SongModel, screen: M8Screen): boolean {
  const project = readProject(screen)
  if (project) return absorbProject(model, project)
  const view = viewOf(screen)
  if (!isPage(view, view.kind)) return false
  return ABSORBERS[view.kind]?.(model, view) ?? false
}
