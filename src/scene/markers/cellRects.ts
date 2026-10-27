// The rectangles a selection covers on screen: its row highlight(s), then the cell itself.

import type { PhraseColumn } from '../../model/columns'
import type { Selection } from '../../model/selection'
import { ROWS_PER_PHRASE } from '../../model/song'
import { INST_CHARS, placeOf } from '../instrumentFace'
import { CHAIN_COL, CHAR_W, INST_COL, NOTE_COL, PANEL_CHARS, PANEL_FIELDS, type Panel, PHRASE_COL, ROW_H, SIDE_FIELDS, SIDE_U0, type SongLayout } from '../layout'
import { FACE_HEADER_WIDTH } from '../track/instrumentFaceView'
import { FRONT_NOTES_W, FRONT_NOTES_X, type TrackView, WALL_STEPS_U, WALL_STEPS_W } from '../track/trackView'
import type { CellRect } from './cellMarker'

/** Room around a cell's characters. */
const CELL_PAD  = 0.12

/** A field's characters at wall u or front x `left`, as a cell rectangle. */
const fieldRect = (parent: CellRect['parent'], left: number, y: number, chars: number): CellRect => ({
  parent,
  x: left - CELL_PAD,
  y,
  w: chars * CHAR_W + 2 * CELL_PAD,
  h: ROW_H
})

/** Rectangles a selection covers: [row highlight..., cell]. The last one is the cell itself. */
export function cellRects(layout: SongLayout, view: TrackView, selection: Selection, panelOf: (table: number) => Panel | undefined): CellRect[] {
  switch (selection.kind) {
    case 'chain': {
      const y = layout.rowY(selection.instance.row)
      // Song view cell: the whole chain (every phrase of its song row) and its own label.
      if (selection.view === 'song') {
        const phrases = layout.timeline.byTrack[selection.instance.track].filter((i) => i.songRow === selection.instance.songRow)
        const last    = phrases.at(-1) ?? selection.instance
        return [{
          parent: view.front,
          x     : FRONT_NOTES_X,
          y,
          w     : FRONT_NOTES_W,
          h     : (last.row - selection.instance.row + ROWS_PER_PHRASE) * ROW_H
        }, fieldRect(view.front, CHAIN_COL * CHAR_W, y, 2)]
      }
      // Chain view row: one phrase of the chain and the phrase label.
      if (selection.view === 'chain') return [{
        parent: view.front,
        x     : FRONT_NOTES_X,
        y,
        w     : FRONT_NOTES_W,
        h     : ROWS_PER_PHRASE * ROW_H
      }, fieldRect(view.front, PHRASE_COL * CHAR_W, y, 2)]
      return [{
        parent: view.front,
        x     : FRONT_NOTES_X,
        y,
        w     : FRONT_NOTES_W,
        h     : ROWS_PER_PHRASE * ROW_H
      }, {
        parent: view.front,
        x     : -0.15,
        y,
        w     : (NOTE_COL - 0.6) * CHAR_W,
        h     : ROW_H
      }]
    }
    case 'step': {
      const y   = layout.rowY(selection.instance.row + selection.step)
      const row : CellRect = {
        parent: view.front,
        x     : FRONT_NOTES_X,
        y,
        w     : FRONT_NOTES_W,
        h     : ROW_H
      }
      // The instrument column is on the front too: it is marked there while the wall is closed.
      if (selection.column === 'note' || (selection.column === 'inst' && view.wallAlpha < 0.5)) {
        const isNote = selection.column === 'note'
        return [row, fieldRect(view.front, (isNote ? NOTE_COL : INST_COL) * CHAR_W, y, isNote ? 3 : 2)]
      }
      const [start, width] = SIDE_FIELDS[selection.column as Exclude<PhraseColumn, 'note'>]
      const wallRow        : CellRect = {
        parent: view.wall,
        x     : WALL_STEPS_U,
        y,
        w     : WALL_STEPS_W,
        h     : ROW_H
      }
      return [row, wallRow, fieldRect(view.wall, SIDE_U0 + start * CHAR_W, y, width)]
    }
    // Panel cells are in the frame of the panel's face (x from its first character, y from its
    // title line): they turn and scale with it.
    case 'table': {
      const panel = panelOf(selection.table)
      if (!panel) return []
      const frame          = view.faceFrame(panel, 'table')
      const y              = -(selection.row + 2) * ROW_H
      const [start, width] = PANEL_FIELDS[selection.column]
      const tableRow       : CellRect = {
        parent: frame,
        x     : -0.3,
        y,
        w     : PANEL_CHARS * CHAR_W + 0.6,
        h     : ROW_H
      }
      return [tableRow, fieldRect(frame, start * CHAR_W, y, width)]
    }
    case 'instrument':
    case 'instParam': {
      const panel = panelOf(selection.table)
      if (!panel) return []
      const frame  = view.faceFrame(panel)
      const header : CellRect = {
        parent: frame,
        x     : -0.45,
        y     : 0.25,
        w     : view.shownFace(panel) === 'inst' ? FACE_HEADER_WIDTH : view.panelWidth(panel),
        h     : ROW_H * 2 + 0.35
      }
      if (selection.kind === 'instrument') return [header]
      // A value is marked on the instrument face; while the table shows, the header stands for it.
      const face  = view.shownFace(panel) === 'inst' ? layout.instrumentFace(selection.instrument) : null
      const place = face ? placeOf(face, selection.screen, selection.line, selection.x) : null
      if (!place) return [header]
      const y    = -place.row * ROW_H
      const cell : CellRect = {
        ...fieldRect(frame, place.col * CHAR_W, y, place.width),
        h: ROW_H * place.height
      }
      // A modulator value is marked on its card alone; a parameter with its row.
      if (selection.screen === 'mods') return [cell]
      return [{
        parent: frame,
        x     : -0.3,
        y,
        w     : INST_CHARS * CHAR_W + 0.4,
        h     : ROW_H
      }, cell]
    }
  }
}
