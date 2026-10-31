// Where the arrow keys take the selection: rows down the song, columns across the step then the
// next track; Shift+arrows a whole phrase up / down, or the same cell in the next track; on a
// table its rows and columns; on an instrument face the nearest value in that direction. Pure
// functions of the layout and the selection.

import { MathUtils } from 'three'
import { PHRASE_COLUMNS, TABLE_COLUMNS } from '../../model/columns'
import type { Selection } from '../../model/selection'
import { ROWS_PER_PHRASE, ROWS_PER_TABLE, TRACKS } from '../../model/song'
import { phraseMoved, trackMoved } from '../../model/stepMoves'
import type { PhraseInstance } from '../../model/timeline'
import { type InstrumentFace, isTitlePlace, placeOf } from '../instrumentFace'
import type { Panel, SongLayout } from '../layout'

type StepSelection = Extract<Selection, { kind: 'step' }>
type FaceSelection = Extract<Selection, { kind: 'instParam' }>

/** With nothing selected, the arrows start on the first step of `track` near height `y` (or its first step). */
export function firstStepNear(layout: SongLayout, track: number, y: number): Selection | null {
  const instances = layout.tracks[track]?.instances ?? []
  const instance  = instances.find((i) => layout.rowY(i.row) <= y + 5) ?? instances[0]
  return instance ? {
    kind  : 'step',
    instance,
    step  : 0,
    column: 'note'
  } : null
}

/**
 * Where an arrow key (`coarse`: with Shift) takes a selection; null when it goes nowhere.
 * `showsFace` tells whether a panel shows its instrument face now (its header then leads onto it).
 */
export function movedSelection(
  layout: SongLayout,
  from: Selection,
  rowDelta: number,
  columnDelta: number,
  coarse: boolean,
  showsFace: (panel: Panel) => boolean,
): Selection | null {
  let selection = from
  if (selection.kind === 'chain') selection = {
    kind    : 'step',
    instance: selection.instance,
    step    : 0,
    column  : 'note'
  }
  if (selection.kind === 'instParam') {
    const face = layout.instrumentFace(selection.instrument)
    return face ? movedOnFace(face, selection, rowDelta, columnDelta) : null
  }
  // From the header of a panel showing its instrument face: onto its first value.
  const headerPanel = selection.kind === 'instrument' ? layout.panelOf(selection.track, selection.table) : undefined
  const headerFace  = headerPanel && showsFace(headerPanel) && headerPanel.instrument != null ? layout.instrumentFace(headerPanel.instrument) : null
  if (selection.kind === 'instrument' && headerFace && selection.instrument != null) {
    const first = headerFace.places.find((place) => place.row > 0)
    return first ? {
      kind      : 'instParam',
      instrument: selection.instrument,
      screen    : first.cell.screen,
      line      : first.cell.line,
      x         : first.cell.x,
      table     : selection.table,
      track     : selection.track
    } : null
  }
  if (selection.kind === 'instrument') {
    selection = {
      kind      : 'table',
      table     : selection.table,
      row       : 0,
      column    : 'transpose',
      track     : selection.track,
      instrument: selection.instrument
    }
  }
  if (selection.kind === 'step') return coarse ? coarseStep(layout, selection, rowDelta, columnDelta) : movedStep(layout, selection, rowDelta, columnDelta)
  const column = coarse ? selection.column : TABLE_COLUMNS[MathUtils.clamp(TABLE_COLUMNS.indexOf(selection.column) + columnDelta, 0, TABLE_COLUMNS.length - 1)]
  const row    = MathUtils.clamp(selection.row + (coarse ? rowDelta * ROWS_PER_TABLE : rowDelta), 0, ROWS_PER_TABLE - 1)
  return { ...selection, row, column }
}

/** Arrows on the instrument face: the nearest value in that direction. */
function movedOnFace(face: InstrumentFace, selection: FaceSelection, rowDelta: number, columnDelta: number): Selection | null {
  const here = placeOf(face, selection.screen, selection.line, selection.x)
  if (!here) return null
  const same    = (cell: typeof here.cell) => cell.screen === here.cell.screen && cell.line === here.cell.line && cell.x === here.cell.x
  let best      : typeof here | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const place of face.places) {
    if (same(place.cell) || isTitlePlace(place)) continue
    const rows    = place.row - here.row
    const columns = place.col - here.col
    if (rowDelta && Math.sign(rows) !== Math.sign(rowDelta)) continue
    if (!rowDelta && (place.row !== here.row || Math.sign(columns) !== Math.sign(columnDelta))) continue
    const score = Math.abs(rows) * 100 + Math.abs(columns)
    if (score < bestScore) [best, bestScore] = [place, score]
  }
  return best ? {
    ...selection,
    screen: best.cell.screen,
    line  : best.cell.line,
    x     : best.cell.x
  } : null
}

/** A step selection moved by Shift+arrows: a whole phrase up / down, or the same cell (row and column) in the next track. */
function coarseStep(layout: SongLayout, selection: StepSelection, rowDelta: number, columnDelta: number): Selection | null {
  const from = {
    instance: selection.instance,
    step    : selection.step
  }
  const to   = columnDelta ? trackMoved(layout.tracks.map((track) => track.instances), from, columnDelta) : phraseMoved(layout.tracks[from.instance.track].instances, from, rowDelta)
  return to ? {
    kind    : 'step',
    instance: to.instance,
    step    : to.step,
    column  : selection.column
  } : null
}

/** A step selection moved by the arrows: across the columns into the next track, down the rows past empty stretches. */
function movedStep(layout: SongLayout, selection: StepSelection, rowDelta: number, columnDelta: number): Selection | null {
  const lastColumn = PHRASE_COLUMNS.length - 1
  let track        = selection.instance.track
  let columnIndex  = PHRASE_COLUMNS.indexOf(selection.column) + columnDelta
  if (columnIndex < 0 || columnIndex > lastColumn) {
    track       = MathUtils.clamp(track + Math.sign(columnDelta), 0, TRACKS - 1)
    columnIndex = track === selection.instance.track ? MathUtils.clamp(columnIndex, 0, lastColumn) : columnDelta > 0 ? 0 : lastColumn
  }
  let row      = selection.instance.row + selection.step + rowDelta
  let instance : PhraseInstance | null = layout.instanceAt(track, row)
  // Skip the empty stretches of the track.
  if (!instance) {
    const instances = layout.tracks[track].instances
    const next      = rowDelta >= 0 ? instances.find((i) => i.row > row) : [...instances].reverse().find((i) => i.row + ROWS_PER_PHRASE <= row)
    const nearest   =
      next ?? instances.reduce<PhraseInstance | null>((best, i) => (!best || Math.abs(i.row - row) < Math.abs(best.row - row) ? i : best), null)
    if (!nearest) return null
    instance       = nearest
    const lastStep = nearest.row + ROWS_PER_PHRASE - 1
    row            = rowDelta >= 0 || !next ? Math.max(nearest.row, Math.min(row, lastStep)) : lastStep
    if (row < nearest.row || row > lastStep) row = nearest.row
  }
  return {
    kind  : 'step',
    instance,
    step  : row - instance.row,
    column: PHRASE_COLUMNS[columnIndex]
  }
}
