// The rectangles a selection covers on screen: its row highlight(s), then the cell itself.

import type { PhraseColumn } from '../../model/columns'
import type { Selection } from '../../model/selection'
import { ROWS_PER_PHRASE } from '../../model/song'
import { CHAR_W, INST_COL, NOTE_COL, PANEL_CHARS, PANEL_FIELDS, type Panel, ROW_H, SIDE_FIELDS, SIDE_U0, type SongLayout } from '../layout'
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
    case 'table': {
      const panel = panelOf(selection.table)
      if (!panel) return []
      const y              = panel.shownY - (selection.row + 2) * ROW_H
      const [start, width] = PANEL_FIELDS[selection.column]
      const tableRow       : CellRect = {
        parent: view.wall,
        x     : panel.shownU - 0.3,
        y,
        w     : PANEL_CHARS * CHAR_W + 0.6,
        h     : ROW_H
      }
      return [tableRow, fieldRect(view.wall, panel.shownU + start * CHAR_W, y, width)]
    }
    case 'instrument': {
      const panel = panelOf(selection.table)
      if (!panel) return []
      return [{
        parent: view.wall,
        x     : panel.shownU - 0.45,
        y     : panel.shownY + 0.25,
        w     : PANEL_CHARS * CHAR_W + 0.9,
        h     : ROW_H * 2 + 0.35
      }]
    }
  }
}
