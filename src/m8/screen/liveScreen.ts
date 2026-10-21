// What the M8 shows right now, compared with the explored song: where its cursor is, whether
// another song is loaded, and edits made on the device folded back into the model.

import { getSemanticContext, type M8Screen, type M8State } from '@yam8d/m8-sdk'
import { type SongModel, TRACKS } from '../../model/song'
import {
  isPage,
  readChain,
  readGroove,
  readInstrument,
  readPhrase,
  readProject,
  readSongRows,
  readTable,
  type ScreenView,
  viewOf,
} from './screenReader'

/** Where the M8 cursor is, in model terms. */
export interface DeviceFocus {
  view  : ScreenView['kind']
  id    : number | null
  /** Row index under the cursor (song row, chain row, step, table row). */
  row   : number | null
  /** Field key under the cursor ('note', 'fx2val', 'track3', ...). */
  column: string | null
}

export function deviceFocus(state: M8State, screen: M8Screen): DeviceFocus | null {
  const view = viewOf(screen)
  if (view.kind === 'other') return null
  const context = getSemanticContext(state, screen)
  return {
    view  : view.kind,
    id    : view.id,
    row   : context?.row?.rowIndex ?? null,
    column: context?.activeField?.key ?? null
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

/** An instrument counts as changed when its name or type did. */
function absorbInstrument(model: SongModel, view: ScreenView): boolean {
  const instrument = readInstrument(view)
  const known      = model.instruments[view.id as number]
  if (!instrument || (known && known.name === instrument.name && known.type === instrument.type)) return false
  model.instruments[instrument.id] = instrument
  return true
}

/** How each view kind folds into the model. */
const ABSORBERS: Partial<Record<ScreenView['kind'], (model: SongModel, view: ScreenView) => boolean>> = {
  song  : absorbSongRows,
  chain : (model, view) => storeIfChanged(model.chains, readChain(view)),
  phrase: (model, view) => storeIfChanged(model.phrases, readPhrase(view)),
  table : (model, view) => storeIfChanged(model.tables, readTable(view)),
  groove: (model, view) => {
    const grooves = { ...model.grooves }
    if (!storeIfChanged(grooves, readGroove(view))) return false
    model.grooves = grooves
    return true
  },
  inst  : absorbInstrument
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
  return ABSORBERS[view.kind]?.(model, view) ?? false
}
